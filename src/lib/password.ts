import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with argon2id, from Node's own crypto (24.7+) — no native
 * add-on to build. Parameters are OWASP's first recommended set: 19 MiB,
 * two passes, one lane. Stored as a PHC string, so the parameters travel
 * with each hash and can be raised later without breaking old ones.
 */

export { PASSWORD_MAX, PASSWORD_MIN, passwordProblem } from "./password-rules";

const PARAMS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };
const SALT_BYTES = 16;

function derive(password: string, salt: Buffer, p: typeof PARAMS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2("argon2id", { message: password, nonce: salt, ...p }, (err, key) =>
      err ? reject(err) : resolve(Buffer.from(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, PARAMS);
  const { memory: m, passes: t, parallelism: p } = PARAMS;
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored);
  if (!match) return false;
  const [, m, t, p, salt, hash] = match;
  const expected = Buffer.from(hash, "base64url");
  const actual = await derive(password, Buffer.from(salt, "base64url"), {
    memory: Number(m),
    passes: Number(t),
    parallelism: Number(p),
    tagLength: expected.length,
  });
  return timingSafeEqual(actual, expected);
}

/** Whether a stored hash was made with weaker parameters than today's. */
export function needsRehash(stored: string): boolean {
  const { memory: m, passes: t, parallelism: p } = PARAMS;
  return !stored.startsWith(`$argon2id$v=19$m=${m},t=${t},p=${p}$`);
}

/**
 * A hash of nothing in particular, verified against when a username doesn't
 * exist — so a wrong username takes as long as a wrong password, and timing
 * can't tell anyone which accounts exist.
 */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}
