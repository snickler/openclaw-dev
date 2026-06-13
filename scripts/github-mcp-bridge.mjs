import { spawn, spawnSync } from "node:child_process";

const SERVER_NAME = "openclaw-github-mcp-bridge";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

function githubToken() {
  const token = String(
    process.env.GITHUB_TOKEN
    || process.env.GH_TOKEN
    || process.env.GITHUB_PERSONAL_ACCESS_TOKEN
    || ""
  ).trim();
  if (/^\$\{[A-Z0-9_]+\}$/.test(token)) {
    return "";
  }
  return token;
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function commandAvailable(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function sendMessage(message) {
  const payload = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
}

function statusLines(extra = "") {
  return [
    "GitHub MCP is running in hosted-safe status mode because no usable GitHub token bridge is available.",
    "Set GITHUB_TOKEN before `devclaw up` / `devclaw deploy` to inject a secret-backed token bridge into the standard ACA runtime.",
    "For ACA Sandbox custom images, set SANDBOX_GITHUB_COPILOT_PAT before `devclaw sandbox build` / `upload`; the wrapper then receives GH_TOKEN/GITHUB_TOKEN at sandbox creation time.",
    "Without a token bridge, do not promise authenticated GitHub issue, PR, label, or repository actions from hosted OpenClaw.",
    extra ? `Detail: ${extra}` : "",
  ].filter(Boolean).join("\n");
}

function sendError(id, code, message) {
  sendMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

function handleStatusModeMessage(message, extraDetail = "") {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.method === "notifications/initialized") {
    return;
  }

  if (message.method === "initialize") {
    sendMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      },
    });
    return;
  }

  if (message.method === "ping") {
    sendMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {},
    });
    return;
  }

  if (message.method === "tools/list") {
    sendMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "github_bridge_status",
            description: "Explain why authenticated GitHub MCP tools are unavailable in the current hosted runtime.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      },
    });
    return;
  }

  if (message.method === "tools/call") {
    if (message.params?.name !== "github_bridge_status") {
      sendError(message.id, -32601, `Unknown tool: ${message.params?.name || "(missing)"}`);
      return;
    }

    sendMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          {
            type: "text",
            text: statusLines(extraDetail),
          },
        ],
        isError: false,
      },
    });
    return;
  }

  if (message.id !== undefined) {
    sendError(message.id, -32601, `Unsupported method in status mode: ${message.method || "(missing)"}`);
  }
}

function runStatusMode(extraDetail = "") {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length > 0) {
      const separatorIndex = buffer.indexOf("\r\n\r\n");
      if (separatorIndex === -1) {
        return;
      }

      const headerText = buffer.subarray(0, separatorIndex).toString("utf8");
      const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        buffer = Buffer.alloc(0);
        return;
      }

      const bodyLength = Number.parseInt(lengthMatch[1], 10);
      const messageStart = separatorIndex + 4;
      const messageEnd = messageStart + bodyLength;
      if (buffer.length < messageEnd) {
        return;
      }

      const body = buffer.subarray(messageStart, messageEnd).toString("utf8");
      buffer = buffer.subarray(messageEnd);

      try {
        handleStatusModeMessage(JSON.parse(body), extraDetail);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendError(null, -32700, `Invalid JSON-RPC payload: ${message}`);
      }
    }
  });

  process.stdin.resume();
}

function runRealServer(token) {
  const npx = npxCommand();
  if (!commandAvailable(npx)) {
    runStatusMode(`Required command '${npx}' is not available in this runtime.`);
    return;
  }

  const packageName = String(process.env.GITHUB_MCP_SERVER_PACKAGE || "").trim();
  if (!packageName) {
    runStatusMode("GITHUB_MCP_SERVER_PACKAGE is not configured. Refusing to fetch a default GitHub MCP package from npm at runtime; configure a reviewed server package or use token-backed gh.");
    return;
  }

  const child = spawn(npx, ["-y", packageName], {
    stdio: "inherit",
    env: {
      ...process.env,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN || token,
      GH_TOKEN: process.env.GH_TOKEN || token,
      GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN || token,
      GH_PROMPT_DISABLED: process.env.GH_PROMPT_DISABLED || "1",
    },
  });

  child.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    runStatusMode(`Failed to start configured GitHub MCP server: ${message}`);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

const token = githubToken();
if (!token) {
  runStatusMode();
} else {
  runRealServer(token);
}
