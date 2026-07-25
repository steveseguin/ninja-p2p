/**
 * `ws` arrives transitively through @vdoninja/sdk and is only used by `doctor`
 * as a WebSocket fallback for Node builds without a global one (Node 20 keeps
 * it behind a flag). We use nothing from it but the constructor, so declare the
 * minimum rather than taking on @types/ws as a dependency.
 */
declare module "ws" {
  const WebSocketImpl: unknown;
  export default WebSocketImpl;
}
