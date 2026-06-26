import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../client.js";
import { formatError } from "../errors.js";

const evidenceLinkSchema = z.object({
  source: z.string().min(1),
  url: z.string().url(),
  label: z.string().optional(),
  summary: z.string().optional(),
});

const timelineMutationSchema = {
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  type: z.string().optional(),
  icon: z.string().optional(),
  source: z.string().optional(),
  source_ref: z.string().optional(),
  started_at: z.string().datetime().optional(),
  ended_at: z.string().datetime().optional(),
  clear_ended_at: z.boolean().optional(),
  is_ongoing: z.boolean().optional(),
  workstream_id: z.number().int().positive().optional(),
  is_key: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  ai_context: z.string().optional(),
  source_window_started_at: z.string().datetime().optional(),
  source_window_ended_at: z.string().datetime().optional(),
  evidence_links: z.array(evidenceLinkSchema).optional(),
};

function definedBody(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      body[key] = value;
    }
  }
  return body;
}

export function registerTimelineTools(
  server: McpServer,
  client: TellagenClient,
): void {
  server.registerTool(
    "tellagen_post_timeline_event",
    {
      description:
        "Create a timeline event on an incident for timestamped RCA facts such as deploys, mitigations, customer impact, and verification milestones.",
      inputSchema: {
        incident_id: z.number().int().positive().describe("Incident ID"),
        ...timelineMutationSchema,
        title: z.string().min(1).describe("Timeline event title"),
      },
    },
    async ({ incident_id, ...params }) => {
      try {
        const data = await client.post(
          `/api/v1/incidents/${incident_id}/timeline`,
          definedBody(params),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "tellagen_get_timeline_event",
    {
      description: "Get one incident timeline event by ID.",
      inputSchema: {
        timeline_event_id: z
          .number()
          .int()
          .positive()
          .describe("Timeline event ID"),
      },
    },
    async ({ timeline_event_id }) => {
      try {
        const data = await client.get(`/api/v1/timeline/${timeline_event_id}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "tellagen_update_timeline_event",
    {
      description:
        "Update a timeline event title, body, timing, tags, key-event flag, workstream, or evidence links.",
      inputSchema: {
        timeline_event_id: z
          .number()
          .int()
          .positive()
          .describe("Timeline event ID"),
        ...timelineMutationSchema,
      },
    },
    async ({ timeline_event_id, ...params }) => {
      try {
        const data = await client.patch(
          `/api/v1/timeline/${timeline_event_id}`,
          definedBody(params),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "tellagen_add_timeline_comment",
    {
      description:
        "Add a comment to a timeline event, optionally as a reply to an existing comment.",
      inputSchema: {
        timeline_event_id: z
          .number()
          .int()
          .positive()
          .describe("Timeline event ID"),
        body: z.string().min(1).describe("Comment body"),
        parent_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Parent comment ID for a threaded reply"),
      },
    },
    async ({ timeline_event_id, body, parent_id }) => {
      try {
        const data = await client.post(
          `/api/v1/timeline/${timeline_event_id}/comments`,
          definedBody({ body, parent_id }),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "tellagen_list_timeline_comments",
    {
      description: "List comments for a timeline event.",
      inputSchema: {
        timeline_event_id: z
          .number()
          .int()
          .positive()
          .describe("Timeline event ID"),
      },
    },
    async ({ timeline_event_id }) => {
      try {
        const data = await client.get(
          `/api/v1/timeline/${timeline_event_id}/comments`,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );
}
