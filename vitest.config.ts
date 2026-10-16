import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // TypeScript compiles test files into dist. Test the source once, even
    // when an older build is present, rather than collecting stale copies.
    exclude: [...configDefaults.exclude, "dist/**", "web/dist/**"],
  },
});
