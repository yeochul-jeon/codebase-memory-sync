#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CmsClient } from "./client.js";
import { createMcpServer } from "./server.js";

const endpoint = process.env["CMS_ENDPOINT"] ?? "http://localhost:3000";
const token = process.env["CMS_TOKEN"];

const client = new CmsClient(endpoint, token);
const server = createMcpServer(client);
const transport = new StdioServerTransport();

await server.connect(transport);
