# Agent Discovery and Configuration

[`agents.ts`](../../agents.ts) owns all agent discovery and parsing. An agent is a Markdown file with YAML frontmatter and a Markdown body used as the subagent's extra system prompt.

## Discovery locations

Agents can come from two scopes:

| Scope | Location | Notes |
| --- | --- | --- |
| User | `~/.pi/agent/agents/*.md` or `$PI_CODING_AGENT_DIR/agents/*.md` | Shared across projects |
| Project | nearest `.pi/agents/*.md` walking upward from cwd | Repository-specific and higher precedence |

Project agents override user agents with the same `name`.

## Agent shape

Parsed agent files produce `AgentConfig`:

```ts
interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  sessionPreference?: "ephemeral" | "persistent" | "either";
  sessionHint?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}
```

Only `name` and `description` are required. Files without those fields are skipped.

## Starter agent

When no agents exist, `discoverAgentsWithStarter` attempts to create a user agent named `explore`. It is a read-only repository exploration agent with:

- `tools: read, grep, find, ls`
- `sessionPreference: persistent`
- a `sessionHint` recommending topic-specific named sessions for iterative exploration

The starter file is created with exclusive write semantics and never overwrites an existing file.

## Parsing behavior

- `tools` can be a comma-separated string or string array.
- Invalid optional fields are ignored with a warning.
- Files are loaded in sorted directory order for deterministic behavior.
- The Markdown body is passed to Pi via `--append-system-prompt`.

## Security and trust boundary

Project agents are codebase-controlled configuration. Because they can influence prompts, tools, model choices, and the parent agent's delegation options, they should be treated as trusted repository content.

The extension does not sandbox project agent prompts. Actual execution isolation comes from spawning separate Pi processes and from whatever tool set the agent definition selects.

