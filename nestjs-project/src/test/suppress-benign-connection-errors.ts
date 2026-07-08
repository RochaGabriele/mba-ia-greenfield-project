/**
 * Global Jest setup — suppress BullMQ's benign teardown error.
 *
 * A BullMQ queue opens ioredis connections that, when torn down while still connecting, reject
 * their pending init with a benign `Connection is closed.` error. BullMQ re-emits it as an
 * EventEmitter `error`; with no live listener Node escalates it to a process `uncaughtException`.
 * Because it fires asynchronously it lands on whichever Jest suite happens to be running at the
 * time, flaking a completely unrelated test.
 *
 * Jest-circus removes any `uncaughtException`/`unhandledRejection` listener registered here for
 * the duration of each test and installs its own, so a normal listener cannot intercept it.
 * Patching `process.emit` can: for this exact benign message we return `true` (Node treats the
 * exception as handled and does not crash, and Jest's listener never observes it). Every other
 * event and error is forwarded to the original emitter untouched.
 */
const BENIGN_MESSAGE = 'Connection is closed.';

type AnyEmit = (event: string | symbol, ...args: unknown[]) => boolean;

const originalEmit = process.emit.bind(process) as AnyEmit;

const patchedEmit: AnyEmit = (event, ...args) => {
  if (
    (event === 'uncaughtException' || event === 'unhandledRejection') &&
    args[0] instanceof Error &&
    args[0].message === BENIGN_MESSAGE
  ) {
    return true;
  }
  return originalEmit(event, ...args);
};

process.emit = patchedEmit as typeof process.emit;
