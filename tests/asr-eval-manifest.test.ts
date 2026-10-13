import path from "node:path"
import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  DEFAULT_ASR_EVAL_MANIFEST_PATH,
  parseAsrEvalManifest,
  resolveManifestPath,
} from "@/lib/ai/asr-eval/manifest"

describe("ASR eval manifest", () => {
  it("accepts a v1 manifest and upgrades it to v2", () => {
    expect(
      parseAsrEvalManifest({
        samples: [{ id: "a", audioPath: "a.wav", referencePath: "a.txt", notes: "n" }],
      })
    ).toEqual({
      version: 2,
      synthetic: false,
      samples: [
        { id: "a", audioPath: "a.wav", referencePath: "a.txt", language: "he", tags: [], notes: "n" },
      ],
    })
  })

  it("ignores v2-only fields on v1 manifests", () => {
    const manifest = parseAsrEvalManifest({
      version: 1,
      samples: [
        { id: "a", audioPath: "a.wav", referencePath: "a.txt", tags: ["x"], referenceTurnsPath: "a.rttm" },
      ],
    })

    expect(manifest.samples[0]).not.toHaveProperty("referenceTurnsPath")
    expect(manifest.samples[0].tags).toEqual([])
  })

  it("parses v2 samples with turns, tags and glossary", () => {
    const manifest = parseAsrEvalManifest({
      version: 2,
      _synthetic: true,
      samples: [
        {
          id: "mixed-1",
          audioPath: "audio/mixed-1.wav",
          referencePath: "ref/mixed-1.txt",
          referenceTurnsPath: "ref/mixed-1.rttm",
          language: "he",
          tags: ["mixed", "meeting", "mixed"],
          glossaryPath: "glossary.json",
        },
      ],
    })

    expect(manifest.synthetic).toBe(true)
    expect(manifest.samples[0]).toMatchObject({
      referenceTurnsPath: "ref/mixed-1.rttm",
      glossaryPath: "glossary.json",
      tags: ["mixed", "meeting"],
    })
  })

  it("rejects invalid manifests with the offending field", () => {
    expect(() => parseAsrEvalManifest(null)).toThrow(/must be an object/)
    expect(() => parseAsrEvalManifest({ samples: [] })).toThrow(/non-empty array/)
    expect(() => parseAsrEvalManifest({ version: 3, samples: [{}] })).toThrow(/unsupported version 3/)
    expect(() =>
      parseAsrEvalManifest({ samples: [{ id: "a", audioPath: "a.wav" }] })
    ).toThrow(/samples\[0\]\.referencePath is required/)
    expect(() =>
      parseAsrEvalManifest({
        samples: [
          { id: "a", audioPath: "a.wav", referencePath: "a.txt" },
          { id: "a", audioPath: "b.wav", referencePath: "b.txt" },
        ],
      })
    ).toThrow(/duplicate sample id 'a'/)
    expect(() =>
      parseAsrEvalManifest({
        version: 2,
        samples: [{ id: "a", audioPath: "a.wav", referencePath: "a.txt", tags: "x" }],
      })
    ).toThrow(/tags must be an array/)
  })

  it("resolves paths relative to the manifest", () => {
    expect(resolveManifestPath("/data/eval/manifest.json", "ref/a.txt")).toBe(
      path.join(path.resolve("/data/eval"), "ref/a.txt")
    )
    expect(resolveManifestPath("m.json", path.resolve("/abs/a.txt"))).toBe(path.resolve("/abs/a.txt"))
    expect(DEFAULT_ASR_EVAL_MANIFEST_PATH).toBe(".secrets/asr-eval/manifest.json")
  })

  it("keeps the committed example manifest valid", () => {
    const example = JSON.parse(
      readFileSync(path.join(process.cwd(), "docs/parity/asr-eval-manifest.example.json"), "utf8")
    )

    expect(parseAsrEvalManifest(example).samples.length).toBeGreaterThan(0)
  })
})
