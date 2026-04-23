#!/usr/bin/env node
import { existsSync, copyFileSync } from "node:fs"

if (!existsSync(".env.local") && existsSync(".env.example")) {
  copyFileSync(".env.example", ".env.local")
  console.log("Created .env.local from .env.example")
} else {
  console.log(".env.local already exists or .env.example is missing")
}

console.log("Run: npm install && npm run dev")
