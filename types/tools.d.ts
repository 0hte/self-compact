// The engine lays the MCP tools' inputs before this mod registers its own, so the tool is declared here.
export {}

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__self-compact__compact_session': { keep: string; then?: string }
  }
}
