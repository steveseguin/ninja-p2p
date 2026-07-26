/**
 * `ws` is the explicit WebSocket fallback for Node builds without a global one
 * (Node 20 keeps it behind a flag). Doctor and the Social Stream bridge use
 * nothing from it but the constructor, so declare the minimum rather than
 * taking on @types/ws as a dependency.
 */
declare module "ws" {
  const WebSocketImpl: unknown;
  export default WebSocketImpl;
}
