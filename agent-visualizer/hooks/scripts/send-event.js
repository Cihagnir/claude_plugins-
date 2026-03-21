#!/usr/bin/env node
"use strict";

const http = require("http");

const PORT = process.env.AGENT_VIZ_PORT || 3399;
let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const body = input.trim();
  if (!body) process.exit(0);

  const req = http.request(
    {
      hostname: "127.0.0.1",
      port: PORT,
      path: "/api/event",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 3000,
    },
    () => process.exit(0)
  );

  req.on("error", () => process.exit(0));
  req.on("timeout", () => {
    req.destroy();
    process.exit(0);
  });
  req.write(body);
  req.end();
});

process.stdin.on("error", () => process.exit(0));
