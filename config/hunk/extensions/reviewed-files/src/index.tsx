import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type {
  ExtensionChangeset,
  ExtensionCommandControls,
  ExtensionDiffFile,
  ExtensionFileViewControls,
  ExtensionKeyboardModeControls,
  ExtensionPaneProps,
  ExtensionReviewNavigation,
  HunkExtensionAPI,
} from "hunkdiff/extension";

const REVIEWED_VIEW_ID = "reviewed";
const REVIEW_NAVIGATION_MODE_ID = "review-navigation";

interface ReviewSelection {
  readonly fileId: string | null;
  readonly hunkIndex: number | null;
}

interface ReviewedFilesSnapshot {
  readonly files: readonly ExtensionDiffFile[];
  readonly visibleFiles: readonly ExtensionDiffFile[];
  readonly reviewedPaths: ReadonlySet<string>;
  readonly selection: ReviewSelection;
  readonly fileReviewMode: boolean;
  readonly activePath: string | null;
}

const initialSnapshot: ReviewedFilesSnapshot = {
  files: [],
  visibleFiles: [],
  reviewedPaths: new Set(),
  selection: { fileId: null, hunkIndex: null },
  fileReviewMode: false,
  activePath: null,
};

let snapshot = initialSnapshot;
let commandControls: ExtensionCommandControls | null = null;
let fileViewControls: ExtensionFileViewControls | null = null;
let keyboardModeControls: ExtensionKeyboardModeControls | null = null;
let reviewNavigation: ExtensionReviewNavigation | null = null;
let pendingBulkApply = false;
let bulkRestorePath: string | null = null;
let bulkApplyTimer: ReturnType<typeof setTimeout> | null = null;
let navigationModeTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

/** Publish one immutable extension-state snapshot. */
function updateSnapshot(update: (current: ReviewedFilesSnapshot) => ReviewedFilesSnapshot) {
  const next = update(snapshot);
  if (next === snapshot) {
    return;
  }

  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Subscribe a mounted pane to session-only reviewed-file state. */
function useReviewedFilesSnapshot() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

/** Match a reviewed path across a rename reported by the next changeset. */
function isReviewed(file: Pick<ExtensionDiffFile, "path" | "previousPath">) {
  return (
    snapshot.reviewedPaths.has(file.path) ||
    (file.previousPath !== undefined && snapshot.reviewedPaths.has(file.previousPath))
  );
}

/** Retain reviewed paths that still exist and canonicalize renames to their current path. */
function reconcileChangeset(changeset: ExtensionChangeset) {
  const reviewedPaths = new Set(
    changeset.files.filter((file) => isReviewed(file)).map((file) => file.path),
  );
  const knownFileIds = new Set(changeset.files.map((file) => file.id));
  const selection = knownFileIds.has(snapshot.selection.fileId ?? "")
    ? snapshot.selection
    : { fileId: null, hunkIndex: null };
  const activeFile = snapshot.activePath
    ? changeset.files.find(
        (file) => file.path === snapshot.activePath || file.previousPath === snapshot.activePath,
      )
    : undefined;
  let fileReviewMode = snapshot.fileReviewMode;
  let activePath = activeFile?.path ?? null;

  if (fileReviewMode && !activeFile) {
    activePath = changeset.files.find((file) => !reviewedPaths.has(file.path))?.path ?? null;
    if (!activePath) {
      fileReviewMode = false;
      pendingBulkApply = reviewedPaths.size > 0;
    }
  }

  const visibleFiles = fileReviewMode
    ? changeset.files.filter((file) => file.path === activePath)
    : changeset.files;
  updateSnapshot((current) => ({
    ...current,
    files: changeset.files,
    visibleFiles,
    reviewedPaths,
    selection,
    fileReviewMode,
    activePath,
  }));

  if (reviewedPaths.size === 0) {
    keyboardModeControls?.exitMode();
  }
}

/** Project the full source changeset into the optional one-file review mode. */
function projectChangeset(changeset: ExtensionChangeset) {
  if (!snapshot.fileReviewMode) {
    return changeset;
  }

  reconcileChangeset(changeset);
  if (!snapshot.fileReviewMode || !snapshot.activePath) {
    return changeset;
  }

  return {
    ...changeset,
    files: changeset.files.filter((file) => file.path === snapshot.activePath),
  };
}

/** Change the explicit one-file review target. */
function setFileReviewTarget(fileReviewMode: boolean, activePath: string | null) {
  updateSnapshot((current) => ({ ...current, fileReviewMode, activePath }));
}

/** Find the next unreviewed path, wrapping only while unfinished files remain. */
function nextUnreviewedPath(currentPath: string) {
  const currentIndex = snapshot.files.findIndex((file) => file.path === currentPath);
  for (let offset = 1; offset <= snapshot.files.length; offset += 1) {
    const file =
      snapshot.files[(currentIndex + offset + snapshot.files.length) % snapshot.files.length];
    if (file && !isReviewed(file)) {
      return file.path;
    }
  }
  return null;
}

/** Replace the currently visible file list without perturbing session state. */
function setVisibleFiles(files: readonly ExtensionDiffFile[]) {
  const unchanged =
    files.length === snapshot.visibleFiles.length &&
    files.every((file, index) => file.id === snapshot.visibleFiles[index]?.id);
  if (unchanged) {
    return;
  }

  updateSnapshot((current) => ({ ...current, visibleFiles: files }));
}

/** Record the current review target immediately enough for keyboard-mode navigation. */
function setSelection(fileId: string | null, hunkIndex: number | null) {
  if (snapshot.selection.fileId === fileId && snapshot.selection.hunkIndex === hunkIndex) {
    return;
  }

  updateSnapshot((current) => ({ ...current, selection: { fileId, hunkIndex } }));
}

/** Toggle one file and return whether it is reviewed afterwards. */
function toggleReviewed(file: ExtensionDiffFile) {
  const reviewed = isReviewed(file);
  const reviewedPaths = new Set(snapshot.reviewedPaths);
  reviewedPaths.delete(file.path);
  if (file.previousPath) {
    reviewedPaths.delete(file.previousPath);
  }
  if (!reviewed) {
    reviewedPaths.add(file.path);
  }

  updateSnapshot((current) => ({ ...current, reviewedPaths }));
  return !reviewed;
}

/** Apply the collapsed presentation to every reviewed file after restoring the full stream. */
function scheduleBulkReviewedPresentation(file: ExtensionDiffFile) {
  if (!pendingBulkApply || !isReviewed(file) || !fileViewControls || !commandControls) {
    return;
  }

  if (!fileViewControls.isActive(REVIEWED_VIEW_ID)) {
    fileViewControls.select(REVIEWED_VIEW_ID);
  }
  if (bulkApplyTimer) {
    clearTimeout(bulkApplyTimer);
  }

  bulkApplyTimer = setTimeout(() => {
    commandControls?.execute("hunk.view.applyFilePresentationToAllMatching");
    pendingBulkApply = false;
    bulkApplyTimer = null;

    const restore = bulkRestorePath
      ? snapshot.files.find((entry) => entry.path === bulkRestorePath)
      : undefined;
    bulkRestorePath = null;
    if (restore && restore.id !== file.id) {
      reviewNavigation?.selectFile(restore.id);
    }
  }, 50);
}

interface HunkCursor {
  readonly fileId: string;
  readonly hunkIndex: number;
}

/** Flatten one file list into its review-stream hunk order. */
function hunkCursors(files: readonly ExtensionDiffFile[]): HunkCursor[] {
  return files.flatMap((file) =>
    (file.hunks ?? []).map((hunk) => ({ fileId: file.id, hunkIndex: hunk.index })),
  );
}

/** Find the next unreviewed hunk without moving opposite the requested direction. */
function nextUnreviewedHunk(direction: -1 | 1): HunkCursor | null {
  const files = snapshot.visibleFiles.length > 0 ? snapshot.visibleFiles : snapshot.files;
  const stream = hunkCursors(files);
  const eligible = hunkCursors(files.filter((file) => !isReviewed(file)));
  if (eligible.length === 0) {
    return null;
  }

  const { fileId, hunkIndex } = snapshot.selection;
  const eligibleIndex = eligible.findIndex(
    (cursor) => cursor.fileId === fileId && cursor.hunkIndex === hunkIndex,
  );
  if (eligibleIndex >= 0) {
    return eligible[Math.min(Math.max(eligibleIndex + direction, 0), eligible.length - 1)] ?? null;
  }

  const streamIndex = stream.findIndex(
    (cursor) => cursor.fileId === fileId && cursor.hunkIndex === hunkIndex,
  );
  if (streamIndex < 0) {
    return direction > 0 ? (eligible[0] ?? null) : (eligible[eligible.length - 1] ?? null);
  }

  const streamPositions = new Map(
    stream.map((cursor, index) => [`${cursor.fileId}\0${cursor.hunkIndex}`, index] as const),
  );
  const ordered = eligible
    .map((cursor) => ({
      cursor,
      index: streamPositions.get(`${cursor.fileId}\0${cursor.hunkIndex}`) ?? -1,
    }))
    .filter((entry) => entry.index >= 0);

  if (direction > 0) {
    return ordered.find((entry) => entry.index > streamIndex)?.cursor ?? null;
  }

  return ordered.findLast((entry) => entry.index < streamIndex)?.cursor ?? null;
}

/** Render every visible file while adding session-only reviewed markers. */
function ReviewedFilesPane({
  files,
  selectedFileId,
  theme,
  actions,
}: ExtensionPaneProps): ReactNode {
  const state = useReviewedFilesSnapshot();

  useEffect(() => {
    setVisibleFiles(files);
  }, [files]);

  const reviewedCount = state.files.filter((file) => isReviewed(file)).length;
  const activeIndex = state.activePath
    ? state.files.findIndex((file) => file.path === state.activePath)
    : -1;
  const heading = state.fileReviewMode
    ? ` File review ${Math.max(1, activeIndex + 1)}/${state.files.length} · ${reviewedCount} reviewed`
    : ` Reviewed ${reviewedCount}/${state.files.length}`;
  const instructions = state.fileReviewMode
    ? " v review + next · V exit mode"
    : " v toggle · V file review · [ ] skip";
  const listedFiles = state.fileReviewMode ? state.files : files;

  return (
    <scrollbox
      width="100%"
      height="100%"
      focused={false}
      scrollY={true}
      viewportCulling={true}
      rootOptions={{ backgroundColor: theme.panel }}
      wrapperOptions={{ backgroundColor: theme.panel }}
      viewportOptions={{ backgroundColor: theme.panel }}
      contentOptions={{ backgroundColor: theme.panel }}
      verticalScrollbarOptions={{ visible: false }}
      horizontalScrollbarOptions={{ visible: false }}
    >
      <box style={{ width: "100%", flexDirection: "column", backgroundColor: theme.panel }}>
        <text content={heading} style={{ fg: theme.accent, bg: theme.panel }} />
        <text content={instructions} style={{ fg: theme.muted, bg: theme.panel }} />
        {listedFiles.map((file) => {
          const reviewed = state.reviewedPaths.has(file.path);
          const selected = state.fileReviewMode
            ? file.path === state.activePath
            : file.id === selectedFileId;
          const path =
            file.previousPath && file.previousPath !== file.path
              ? `${file.previousPath} -> ${file.path}`
              : file.path;
          const truncated = file.statsTruncated ? ">" : "";

          return (
            <text
              key={file.id}
              content={` ${reviewed ? "✓" : "○"} ${path}  ${truncated}+${file.stats.additions} -${file.stats.deletions}`}
              style={{
                fg: reviewed ? theme.badgeAdded : theme.text,
                bg: selected ? theme.selectedHunk : theme.panel,
              }}
              onMouseUp={() => {
                if (!state.fileReviewMode) {
                  actions.selectFile(file.id);
                  return;
                }
                if (file.path === state.activePath) {
                  return;
                }

                setFileReviewTarget(true, file.path);
                if (!commandControls?.execute("hunk.app.refresh")) {
                  actions.notify("Could not switch the focused file", "warning");
                }
              }}
            />
          );
        })}
      </box>
    </scrollbox>
  );
}

/** Register the reviewed presentation, pane, commands, and navigation policy. */
export default function reviewedFiles(hunk: HunkExtensionAPI) {
  hunk.configureSession({ viewPreferences: "transient" });
  hunk.transformChangeset((changeset) => projectChangeset(changeset));

  hunk.registerFileView({
    id: REVIEWED_VIEW_ID,
    title: "Reviewed (collapsed)",
    matches: (file) => isReviewed(file),
    layout: ({ file }) => {
      const hunks = file.hunks ?? [];
      return {
        rows: hunks.map((hunk) => ({
          id: `reviewed:${hunk.index}`,
          spans: [{ text: "" }],
          sourceRanges: [
            ...(hunk.oldRange && hunk.oldRange[0] >= 1
              ? [{ side: "old" as const, range: hunk.oldRange }]
              : []),
            ...(hunk.newRange && hunk.newRange[0] >= 1
              ? [{ side: "new" as const, range: hunk.newRange }]
              : []),
          ],
        })),
        hunkRows: hunks.map((_, index) => ({ startRow: index, endRow: index })),
      };
    },
  });

  hunk.registerPane({
    id: "files",
    title: "Reviewed files",
    placement: "left",
    width: { preferred: 36, min: 24 },
    replaces: "hunk:files",
    component: ReviewedFilesPane,
  });

  hunk.registerKeyboardMode({
    id: REVIEW_NAVIGATION_MODE_ID,
    title: "Reviewed-file navigation",
    onKey: (key) => {
      const sequence = key.sequence ?? key.name;
      if (sequence !== "[" && sequence !== "]") {
        return "pass";
      }

      const target = nextUnreviewedHunk(sequence === "]" ? 1 : -1);
      if (target && reviewNavigation) {
        setSelection(target.fileId, target.hunkIndex);
        reviewNavigation.selectHunk(target.fileId, target.hunkIndex);
      }
      return "handled";
    },
  });

  hunk.registerCommand(
    {
      id: "toggle-file-review-mode",
      title: "Toggle file-by-file review mode",
      key: "V",
    },
    (ctx) => {
      commandControls = ctx.commands;
      fileViewControls = ctx.fileViews;
      keyboardModeControls = ctx.keyboardModes;
      reviewNavigation = ctx.navigation;

      if (!ctx.commands.isEnabled("hunk.app.refresh")) {
        ctx.notify("File-by-file mode requires a refreshable review", "warning");
        return;
      }

      if (snapshot.fileReviewMode) {
        bulkRestorePath = ctx.selection.file?.path ?? null;
        pendingBulkApply = snapshot.reviewedPaths.size > 0;
        setFileReviewTarget(false, null);
        ctx.commands.execute("hunk.app.refresh");
        ctx.notify("Exited file-by-file review mode");
        return;
      }

      const selected = ctx.selection.file;
      const activePath =
        selected && !isReviewed(selected)
          ? selected.path
          : selected
            ? nextUnreviewedPath(selected.path)
            : snapshot.files.find((file) => !isReviewed(file))?.path;
      if (!activePath) {
        ctx.notify("Every file is already reviewed");
        return;
      }

      setFileReviewTarget(true, activePath);
      ctx.commands.execute("hunk.app.refresh");
      ctx.notify("Entered file-by-file review mode");
    },
  );

  hunk.registerCommand(
    {
      id: "toggle-reviewed",
      title: "Mark or unmark selected file as reviewed",
      key: "v",
    },
    (ctx) => {
      const file = ctx.selection.file;
      if (!file) {
        ctx.notify("No file is selected", "warning");
        return;
      }

      commandControls = ctx.commands;
      fileViewControls = ctx.fileViews;
      keyboardModeControls = ctx.keyboardModes;
      reviewNavigation = ctx.navigation;
      setSelection(file.id, ctx.selection.hunkIndex);

      const reviewed = toggleReviewed(file);
      ctx.fileViews.select(reviewed ? REVIEWED_VIEW_ID : null);
      if (reviewed && !ctx.keyboardModes.isActive(REVIEW_NAVIGATION_MODE_ID)) {
        if (navigationModeTimer) {
          clearTimeout(navigationModeTimer);
        }
        navigationModeTimer = setTimeout(() => {
          keyboardModeControls?.enterMode(REVIEW_NAVIGATION_MODE_ID);
          navigationModeTimer = null;
        }, 500);
      } else if (!reviewed && snapshot.reviewedPaths.size === 0) {
        ctx.keyboardModes.exitMode();
      }

      if (snapshot.fileReviewMode && reviewed) {
        const nextPath = nextUnreviewedPath(file.path);
        if (nextPath) {
          setFileReviewTarget(true, nextPath);
          ctx.commands.execute("hunk.app.refresh");
          ctx.notify(`${file.path} reviewed · opening next file`);
          return;
        }

        bulkRestorePath = file.path;
        pendingBulkApply = true;
        setFileReviewTarget(false, null);
        ctx.commands.execute("hunk.app.refresh");
        ctx.notify(`${file.path} reviewed · file-by-file review complete`);
        return;
      }

      ctx.notify(`${file.path} marked ${reviewed ? "reviewed" : "unreviewed"}`);
    },
  );

  hunk.on("startup", (_event, ctx) => {
    reviewNavigation = ctx.navigation;
  });

  hunk.on("changeset_loaded", ({ changeset }, ctx) => {
    reviewNavigation = ctx.navigation;
    if (!snapshot.fileReviewMode) {
      reconcileChangeset(changeset);
    }
  });

  hunk.on("selection_changed", ({ fileId, hunkIndex }, ctx) => {
    reviewNavigation = ctx.navigation;
    setSelection(fileId, hunkIndex);
  });

  hunk.on("file_viewed", ({ file, hunkIndex }, ctx) => {
    reviewNavigation = ctx.navigation;
    setSelection(file.id, hunkIndex);
    if (!fileViewControls) {
      return;
    }

    if (pendingBulkApply && !isReviewed(file)) {
      const reviewedFile = snapshot.files.find((entry) => isReviewed(entry));
      if (reviewedFile && reviewedFile.id !== file.id) {
        ctx.navigation.selectFile(reviewedFile.id);
        return;
      }
    }

    if (isReviewed(file)) {
      if (!fileViewControls.isActive(REVIEWED_VIEW_ID)) {
        fileViewControls.select(REVIEWED_VIEW_ID);
      }
      scheduleBulkReviewedPresentation(file);
    } else if (fileViewControls.isActive(REVIEWED_VIEW_ID)) {
      fileViewControls.select(null);
    }
  });

  hunk.on("shutdown", () => {
    if (bulkApplyTimer) {
      clearTimeout(bulkApplyTimer);
      bulkApplyTimer = null;
    }
    if (navigationModeTimer) {
      clearTimeout(navigationModeTimer);
      navigationModeTimer = null;
    }
    commandControls = null;
    fileViewControls = null;
    keyboardModeControls = null;
    reviewNavigation = null;
    pendingBulkApply = false;
    bulkRestorePath = null;
  });
}
