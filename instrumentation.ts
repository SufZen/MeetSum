export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertRuntimeEnvironment } = await import("@/lib/ops/environment")

    assertRuntimeEnvironment()
  }
}
