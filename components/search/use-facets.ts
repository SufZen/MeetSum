"use client"

/** Filter values from visible meetings (`GET /api/search/facets`, B7). */
import { useEffect, useState } from "react"

import type { SearchFacets } from "@/lib/search/types"

export const EMPTY_FACETS: SearchFacets = {
  people: [],
  speakers: [],
  rooms: [],
  tags: [],
  languages: [],
  meetingTypes: [],
  sources: [],
}

/** Accepts the facets object or `{facets}`; missing lists become empty. */
export function readFacets(body: unknown): SearchFacets {
  const raw = (body && typeof body === "object" && "facets" in body ? (body as { facets: unknown }).facets : body) as
    | Partial<SearchFacets>
    | null
    | undefined

  if (!raw || typeof raw !== "object") return EMPTY_FACETS

  const list = <T,>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : [])

  return {
    people: list(raw.people),
    speakers: list(raw.speakers),
    rooms: list(raw.rooms),
    tags: list(raw.tags),
    languages: list(raw.languages),
    meetingTypes: list(raw.meetingTypes),
    sources: list(raw.sources),
  }
}

export function useFacets(initialRooms: SearchFacets["rooms"] = []) {
  const [facets, setFacets] = useState<SearchFacets>({ ...EMPTY_FACETS, rooms: initialRooms })

  useEffect(() => {
    const controller = new AbortController()

    void fetch("/api/search/facets", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body) => {
        if (!body) return

        const next = readFacets(body)

        setFacets(next.rooms.length ? next : { ...next, rooms: initialRooms })
      })
      .catch(() => undefined)

    return () => controller.abort()
    // Facets load once per page view; rooms from the server are only a fallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return facets
}
