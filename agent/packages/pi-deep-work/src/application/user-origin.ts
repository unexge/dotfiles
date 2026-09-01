const userOriginToken = Symbol("user-origin");
const registeredOrigins = new WeakSet<UserOrigin>();

export class UserOrigin {
	readonly #registeredCommandBrand = true;

	constructor(token: typeof userOriginToken, readonly goal: string) {
		if (token !== userOriginToken || !goal.trim()) throw new Error("UserOrigin requires a registered nonempty /deep command");
		registeredOrigins.add(this);
		Object.freeze(this);
	}
}

/**
 * This factory is called only from the registered extension command handler. Delegated model sessions expose no
 * module loader, bash tool, or custom tool that reaches it; all in-process callers are trusted coordinator code.
 */
export function userOriginFromRegisteredCommand(goal: string): UserOrigin {
	return new UserOrigin(userOriginToken, goal);
}

/** Uses the current registered command only as authority to re-mint the original persisted user goal. */
export function userOriginForPersistedGoal(commandOrigin: UserOrigin, goal: string): UserOrigin {
	assertUserOrigin(commandOrigin);
	return new UserOrigin(userOriginToken, goal);
}

export function assertUserOrigin(origin: UserOrigin): void {
	if (!registeredOrigins.has(origin)) throw new Error("UserOrigin was not created by the registered /deep command boundary");
}
