/**
 * Next.js instrumentation hook.
 *
 * Captures the immediate TCP peer address for Node-runtime requests so the API
 * boundary can distinguish a trusted reverse proxy from a direct client. This is
 * transport-layer data; it is never derived from client-supplied headers.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installPeerAddressCapture } = await import("@/src/api/peer-address");
    installPeerAddressCapture();
  }
}
