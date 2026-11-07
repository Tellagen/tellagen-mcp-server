import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../client.js";
import { formatError } from "../errors.js";

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function registerContextTools(
  server: McpServer,
  client: TellagenClient,
): void {
  server.registerTool(
    "tellagen_get_impact_summary",
    {
      description:
        "Read the customer-impact summary of an incident. For the individual customers, use tellagen_list_affected_customers. It changes nothing.",
      inputSchema: {
        incident_id: z.number().int().positive().describe("Incident ID"),
      },
    },
    async ({ incident_id }) => {
      try {
        const data = await client.get(
          `/api/v1/incidents/${incident_id}/impact-summary`,
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
    "tellagen_list_affected_customers",
    {
      description:
        "List the customers affected by an incident, with optional status and email filters and pagination. For totals, use tellagen_get_impact_summary. It changes nothing.",
      inputSchema: {
        incident_id: z.number().int().positive().describe("Incident ID"),
        status: z.string().optional(),
        email: z.string().email().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().optional(),
      },
    },
    async ({ incident_id, status, email, limit, cursor }) => {
      try {
        const params = new URLSearchParams();
        if (status !== undefined) params.set("status", status);
        if (email !== undefined) params.set("email", email);
        if (limit !== undefined) params.set("limit", String(limit));
        if (cursor !== undefined) params.set("cursor", cursor);
        const data = await client.get(
          withQuery(`/api/v1/incidents/${incident_id}/affected-customers`, params),
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
    "tellagen_search",
    {
      description:
        "Search the workspace for incidents, timeline events, issues, services and related records. Use it when you do not know an ID. Returns matching records with their types. It changes nothing.",
      inputSchema: {
        q: z.string().min(2).optional().describe("Search query"),
        filters: z.string().optional().describe("Advanced filter string"),
        types: z.array(z.string()).optional(),
        incident_id: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        date_from: z.string().datetime().optional(),
        date_to: z.string().datetime().optional(),
      },
    },
    async ({
      q,
      filters,
      types,
      incident_id,
      limit,
      offset,
      date_from,
      date_to,
    }) => {
      try {
        const params = new URLSearchParams();
        if (q !== undefined) params.set("q", q);
        if (filters !== undefined) params.set("filters", filters);
        if (types !== undefined && types.length > 0) {
          params.set("types", types.join(","));
        }
        if (incident_id !== undefined) {
          params.set("incident_id", String(incident_id));
        }
        if (limit !== undefined) params.set("limit", String(limit));
        if (offset !== undefined) params.set("offset", String(offset));
        if (date_from !== undefined) params.set("date_from", date_from);
        if (date_to !== undefined) params.set("date_to", date_to);

        const data = await client.get(withQuery("/api/v1/search", params));
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
    "tellagen_list_services",
    {
      description: "List the services in the Tellagen service catalog. Use it to find a service ID. For one entry, call tellagen_get_service. It changes nothing.",
      inputSchema: {
        include_archived: z.boolean().optional(),
      },
    },
    async ({ include_archived }) => {
      try {
        const params = new URLSearchParams();
        if (include_archived) params.set("include_archived", "true");
        const data = await client.get(withQuery("/api/v1/services", params));
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
    "tellagen_get_service",
    {
      description: "Read one service catalog entry by ID, with its metadata. It changes nothing.",
      inputSchema: {
        service_id: z.number().int().positive().describe("Service ID"),
      },
    },
    async ({ service_id }) => {
      try {
        const data = await client.get(`/api/v1/services/${service_id}`);
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
