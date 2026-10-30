import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import path from "node:path";

const PREFIX = "OMP_DESKTOP_EVIDENCE_REQUEST:";
export function bootstrapFromEnv() {
  try {
    const value = JSON.parse(
      process.env.OMP_DESKTOP_EVIDENCE_BOOTSTRAP || "null",
    );
    if (
      value?.version === 1 &&
      value.policy?.preset &&
      (value.inbox === null ||
        (typeof value.inbox === "string" && path.isAbsolute(value.inbox)))
    )
      return value;
  } catch {
    /* Missing host is reported by the caller. */
  }
  return null;
}
export function createHost(epoch, bootstrap, timeout = 10000) {
  async function request(ctx, op, args = {}) {
    if (!bootstrap || typeof ctx.ui?.input !== "function")
      throw new Error("Evidence host service is unavailable");
    const sessionId = ctx.sessionManager.getSessionId(),
      file = ctx.sessionManager.getSessionFile() ?? null;
    if (!sessionId) throw new Error("Evidence session identity is unavailable");
    const title =
      PREFIX + JSON.stringify({ version: 1, epoch, sessionId, file, op, args });
    let timer;
    const controller = new AbortController();
    try {
      const answer = await Promise.race([
        Promise.resolve(
          ctx.ui.input(title, undefined, { signal: controller.signal }),
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Evidence ${op} request timed out`));
            controller.abort();
          }, timeout);
        }),
      ]);
      if (typeof answer !== "string" || Buffer.byteLength(answer) > 256 * 1024)
        throw new Error(`Evidence ${op} returned an invalid response`);
      let result;
      try {
        result = JSON.parse(answer);
      } catch {
        throw new Error(`Evidence ${op} returned invalid JSON`);
      }
      if (
        !result ||
        typeof result !== "object" ||
        typeof result.ok !== "boolean"
      )
        throw new Error(`Evidence ${op} returned an invalid response`);
      if (!result.ok)
        throw new Error(
          typeof result.error === "string"
            ? result.error
            : `Evidence ${op} failed`,
        );
      return result.value;
    } finally {
      clearTimeout(timer);
    }
  }
  async function stage(ctx, source) {
    if (!bootstrap?.inbox)
      throw new Error("Private evidence artifact storage is unavailable");
    if (
      typeof source !== "string" ||
      !source.trim() ||
      Buffer.byteLength(source) > 2048
    )
      throw new Error("Invalid artifact path");
    const original = path.resolve(ctx.cwd || process.cwd(), source);
    const limit = 64 * 1024 * 1024;
    const extension = path
      .extname(original)
      .slice(0, 20)
      .replace(/[^.a-zA-Z0-9]/g, "");
    const filename = `${randomUUID()}${extension}`;
    const destination = path.join(bootstrap.inbox, filename);
    let input, output;
    try {
      input = await open(
        original,
        constants.O_RDONLY | (constants.O_NONBLOCK || 0),
      );
      const info = await input.stat();
      if (!info.isFile() || info.size > limit)
        throw new Error("Artifact must be a regular file of at most 64 MiB");
      output = await open(destination, "wx", 0o600);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, total);
        if (!bytesRead) break;
        if (total + bytesRead > limit)
          throw new Error(
            "Artifact grew beyond the 64 MiB limit during staging",
          );
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(
            buffer,
            written,
            bytesRead - written,
          );
          if (!result.bytesWritten)
            throw new Error("Artifact staging could not write the file");
          written += result.bytesWritten;
        }
        total += bytesRead;
      }
      const after = await input.stat();
      if (
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        total !== info.size
      )
        throw new Error("Artifact changed during staging; capture it again");
      await output.close();
      output = undefined;
      await input.close();
      input = undefined;
      return await request(ctx, "import", {
        filename,
        name: path.basename(original).slice(0, 255),
      });
    } finally {
      await output?.close().catch(() => {});
      await input?.close().catch(() => {});
      await unlink(destination).catch(() => {});
    }
  }
  return { request, stage };
}
