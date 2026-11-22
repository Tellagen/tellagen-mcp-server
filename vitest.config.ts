import { defineConfig } from "vitest/config";

// The tests never look at the git checkouts of the computer they run on.
// A test that needs them sets TELLAGEN_CODE_CHECKOUTS itself.
export default defineConfig({
  test: { env: { TELLAGEN_CODE_CHECKOUTS: "off" } },
});
