/** Shared by session authorization and API handlers, without an auth import cycle. */
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
