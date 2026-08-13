;; init.el - Managed by dotfiles (scripts/links.sh)

;; --- Package setup ---
(require 'package)
(add-to-list 'package-archives
             '("melpa" . "https://melpa.org/packages/") t)
(package-initialize)

;; Auto-install packages, refreshing the archive cache when anything is missing
(let ((pkgs '(magit magit-delta difftastic gruvbox-theme)))
  (when (seq-some (lambda (p) (not (package-installed-p p))) pkgs)
    (package-refresh-contents))
  (dolist (pkg pkgs)
    (unless (package-installed-p pkg)
      (package-install pkg))))

;; --- Theme ---
;; Never let a degraded TERM make Emacs assume a light background
;; (that turns magit section highlights into unreadable grey95 bars).
(setq frame-background-mode 'dark)
(load-theme 'gruvbox-dark-hard t)

;; --- Magit ---
(setq magit-display-buffer-function 'magit-display-buffer-fullframe-status-v1)
(require 'magit-delta)
;; magit-delta passes --syntax-theme on the command line, overriding the
;; syntax-theme from .config/git/delta.gitconfig.  Its default ("Monokai
;; Extended") clashes with gruvbox-dark-hard, so pin it to gruvbox-dark.
(setq magit-delta-default-dark-theme "gruvbox-dark")
(add-hook 'magit-mode-hook (lambda () (magit-delta-mode +1)))

;; --- Difftastic (structural diffs as default in Magit) ---
;; Requires the `difft' CLI (brew install difftastic).
;; Replaces the `d' (diff dwim) and `c' (show commit) suffixes in the
;; `magit-diff' transient so `d d' and `d c' run difftastic.  The inline
;; diffs in `magit-status' still use Magit's own renderer because their
;; hunks need to remain stage/apply-able.
(with-eval-after-load 'magit-diff
  (require 'difftastic)
  (transient-replace-suffix 'magit-diff 'magit-diff-dwim
    '("d" "Diff (dwim)" difftastic-magit-diff))
  (transient-replace-suffix 'magit-diff 'magit-show-commit
    '("c" "Show commit" difftastic-magit-show)))

;; --- macOS ---
(setq mac-command-modifier 'meta)
(custom-set-variables
 ;; custom-set-variables was added by Custom.
 ;; If you edit it by hand, you could mess it up, so be careful.
 ;; Your init file should contain only one such instance.
 ;; If there is more than one, they won't work right.
 '(custom-safe-themes
   '("2c7dc80264de0ba9409d4ebb3c7b31cf8e4982015066174c786f16a672db71b2"
     "6a95b0faf6cee6adfda34cdfadb2fed6f4157a1d49aabef8cc9b94c187d69a1d"
     "2b9e0d7bceebee7473c100ecbf2c76a65b6e2129c73775f5949e39a677fa621f"
     default))
 '(package-selected-packages nil))
(custom-set-faces
 ;; custom-set-faces was added by Custom.
 ;; If you edit it by hand, you could mess it up, so be careful.
 ;; Your init file should contain only one such instance.
 ;; If there is more than one, they won't work right.
 )
