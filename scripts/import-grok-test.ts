import {
  importGrokCliAuth,
  loadGrokCliCredentials,
} from "../src/auth/xai-oauth.js";
import { getCredential } from "../src/auth/store.js";

async function main() {
  const loaded = loadGrokCliCredentials();
  console.log(
    "loadGrokCli",
    loaded
      ? {
          accessLen: loaded.access.length,
          refreshLen: loaded.refresh.length,
          exp: new Date(loaded.expires).toISOString(),
        }
      : null,
  );
  const r = await importGrokCliAuth();
  console.log("import", r.ok ? "ok" : r.error);
  if (r.ok) {
    const c = getCredential("xai");
    console.log("stored", {
      method: c?.method,
      label: c?.label,
      hasRefresh: Boolean(c?.refreshToken),
      exp: c?.expiresAt ? new Date(c.expiresAt).toISOString() : null,
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
