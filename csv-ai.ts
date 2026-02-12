#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env

import { parseArgs } from "jsr:@std/cli@1.0.21/parse-args";
import { parse } from "jsr:@std/csv@1.0.6/parse";

const HELP = `
csv-ai — Run each CSV row through an AI prompt and stream the result as CSV.

USAGE:
  csv-ai --file <path> --prompt <text> --model <model> --api-url <url> --auth-header <header>

OPTIONS:
  -f, --file         Path to the CSV file
  -p, --prompt       Prompt template. The row data (as key: value) is appended after the prompt.
  -m, --model        Model name (e.g. gpt-4o, openai/gpt-4o for OpenRouter)
  -u, --api-url      OpenAI-compatible API base URL (e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1)
  -a, --auth-header  Authorization header value (e.g. "Bearer sk-...")
  -c, --output-column  Name of the new column for AI output (default: result)
  -h, --help         Show this help
`;

function escapeCsvField(value: string): string {
  const s = String(value ?? "");
  if (
    s.includes(",") ||
    s.includes('"') ||
    s.includes("\n") ||
    s.includes("\r")
  ) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function formatRow(headers: string[], values: string[]): string {
  return values.map(escapeCsvField).join(",");
}

async function chat(
  apiUrl: string,
  authHeader: string,
  model: string,
  userContent: string,
): Promise<string> {
  const url = apiUrl.replace(/\/$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader.startsWith("Bearer ")
        ? authHeader
        : `Bearer ${authHeader}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (content == null) {
    throw new Error("No content in API response");
  }
  return content.trim();
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: [
      "file",
      "prompt",
      "model",
      "api-url",
      "auth-header",
      "output-column",
    ],
    alias: {
      file: "f",
      prompt: "p",
      model: "m",
      "api-url": "u",
      "auth-header": "a",
      "output-column": "c",
    },
  });

  if (
    args.help ||
    !args.file ||
    !args.prompt ||
    !args.model ||
    !args["api-url"] ||
    !args["auth-header"]
  ) {
    console.error(HELP);
    Deno.exit(args.help ? 0 : 1);
  }

  const file = args.file as string;
  const promptTemplate = args.prompt as string;
  const model = args.model as string;
  const apiUrl = args["api-url"] as string;
  const authHeader = args["auth-header"] as string;
  const outputColumn = (args["output-column"] as string) || "result";

  const raw = await Deno.readTextFile(file);
  const rows = parse(raw, { skipFirstRow: false }) as string[][];

  if (rows.length === 0) {
    console.error("CSV has no rows");
    Deno.exit(1);
  }

  const headers = rows[0];
  const dataRows = rows.slice(1);

  // Stream header line (original columns + new column)
  const outHeaders = [...headers, outputColumn];
  console.log(formatRow(outHeaders, outHeaders));

  for (let i = 0; i < dataRows.length; i++) {
    const rawValues = dataRows[i];
    const values = headers.map((_, j) => rawValues[j] ?? "");
    const record: Record<string, string> = {};
    headers.forEach((h, j) => {
      record[h] = values[j];
    });

    const rowBlock = headers.map((h) => `${h}: ${record[h]}`).join("\n");
    const userContent = `${promptTemplate}\n\nRow data:\n${rowBlock}`;

    try {
      const result = await chat(apiUrl, authHeader, model, userContent);
      const outValues = [...values, result];
      console.log(formatRow(outHeaders, outValues));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Row ${i + 2} error: ${msg}`);
      const shortMsg = msg.split("\n")[0].slice(0, 200);
      const outValues = [...values, `[error: ${shortMsg.replace(/"/g, '""')}]`];
      console.log(formatRow(outHeaders, outValues));
    }
  }
}

main();
