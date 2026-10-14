"use client"

/**
 * Search filters bar (D1): date presets plus a custom range, people, rooms,
 * tags, meeting type, language and kind chips, and Clear all. Every change
 * goes straight to the URL state.
 */
import { CalendarIcon, CheckIcon, ChevronDownIcon, XIcon } from "lucide-react"
import { useState } from "react"

import { KIND_KEYS } from "@/components/search/search-results"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  DATE_PRESETS,
  SEARCH_KINDS,
  SEARCH_LANGUAGES,
  clearFilters,
  hasActiveFilters,
  toggleListValue,
  type DatePreset,
  type SearchUrlState,
} from "@/lib/client/search-url"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { formatMessage } from "@/lib/i18n/messages"
import { meetingTypeLabel } from "@/lib/search/meeting-type-labels"
import type { SearchFacets, TextLanguage } from "@/lib/search/types"
import { cn } from "@/lib/utils"

const LANGUAGE_KEYS: Record<TextLanguage, keyof Dictionary> = {
  he: "searchLanguageHe",
  en: "searchLanguageEn",
  mixed: "searchLanguageMixed",
}

const PRESET_KEYS: Record<DatePreset, keyof Dictionary> = {
  "7": "searchDate7",
  "30": "searchDate30",
  "90": "searchDate90",
}

const chip =
  "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors duration-(--dur-1) focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent"
const chipOff = "border-line-strong bg-surface text-fg-2 hover:bg-surface-3"
const chipOn = "border-brand bg-brand-soft font-medium text-brand-text"

type Option = { value: string; label: string; hint?: string }

function MultiSelect({
  label,
  options,
  selected,
  onChange,
  dictionary: t,
  filterable,
}: {
  label: string
  options: Option[]
  selected: string[]
  onChange: (next: string[]) => void
  dictionary: Dictionary
  filterable?: boolean
}) {
  const [filter, setFilter] = useState("")
  const visible = filter.trim()
    ? options.filter((option) => option.label.toLowerCase().includes(filter.trim().toLowerCase()))
    : options
  // Keep selected values that aren't in the facets (e.g. from a shared link).
  const extra = selected.filter((value) => !options.some((option) => option.value === value))

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button type="button" data-filter={label} className={cn(chip, selected.length ? chipOn : chipOff)} />
        }
      >
        {selected.length ? formatMessage(t.searchSelectedCount, { label, count: selected.length }) : label}
        <ChevronDownIcon aria-hidden className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-1 p-1.5">
        {filterable && options.length > 8 ? (
          <Input
            dir="auto"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t.searchFilterSearch}
            aria-label={t.searchFilterSearch}
            className="mb-1 h-8"
          />
        ) : null}
        {!options.length && !extra.length ? <p className="px-2 py-1.5 text-sm text-fg-3">{t.searchNoOptions}</p> : null}
        <ul role="listbox" aria-multiselectable="true" aria-label={label} className="ms-scrollbar grid max-h-64 overflow-y-auto">
          {[...extra.map((value): Option => ({ value, label: value })), ...visible].map((option) => {
            const checked = selected.includes(option.value)

            return (
              <li key={option.value} role="option" aria-selected={checked}>
                <button
                  type="button"
                  onClick={() => onChange(toggleListValue(selected, option.value))}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-surface-3 focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded-xs border",
                      checked ? "border-brand bg-brand text-on-brand" : "border-line-control"
                    )}
                  >
                    {checked ? <CheckIcon className="size-3" /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <bdi>{option.label}</bdi>
                  </span>
                  {option.hint ? <span className="text-xs text-fg-3 tabular-nums">{option.hint}</span> : null}
                </button>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function DateFilter({
  state,
  onChange,
  dictionary: t,
}: {
  state: SearchUrlState
  onChange: (next: SearchUrlState) => void
  dictionary: Dictionary
}) {
  const custom = !state.range && Boolean(state.from || state.to)
  const label = state.range
    ? t[PRESET_KEYS[state.range]]
    : custom
      ? [state.from, state.to].filter(Boolean).join(" – ")
      : t.searchDate

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button type="button" data-filter="date" className={cn(chip, state.range || custom ? chipOn : chipOff)} />
        }
      >
        <CalendarIcon aria-hidden className="size-3.5" />
        <span className="[unicode-bidi:isolate]">{label}</span>
        <ChevronDownIcon aria-hidden className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-2 p-2">
        <div role="radiogroup" aria-label={t.searchDate} className="grid gap-0.5">
          {[undefined, ...DATE_PRESETS].map((preset) => {
            const active = preset === undefined ? !state.range && !custom : state.range === preset

            return (
              <button
                key={preset ?? "any"}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChange({ ...state, range: preset, from: undefined, to: undefined })}
                className={cn(
                  "rounded-md px-2 py-1.5 text-start text-sm hover:bg-surface-3 focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent",
                  active && "bg-brand-soft font-medium text-brand-text"
                )}
              >
                {preset ? t[PRESET_KEYS[preset]] : t.searchDateAny}
              </button>
            )
          })}
        </div>
        <fieldset className="grid gap-1.5 border-t border-line pt-2">
          <legend className="text-xs text-fg-3">{t.searchDateCustom}</legend>
          <label className="grid gap-0.5 text-xs text-fg-2">
            {t.searchDateFrom}
            <Input
              type="date"
              dir="ltr"
              value={state.from ?? ""}
              max={state.to}
              onChange={(event) => onChange({ ...state, range: undefined, from: event.target.value || undefined })}
              className="h-8"
            />
          </label>
          <label className="grid gap-0.5 text-xs text-fg-2">
            {t.searchDateTo}
            <Input
              type="date"
              dir="ltr"
              value={state.to ?? ""}
              min={state.from}
              onChange={(event) => onChange({ ...state, range: undefined, to: event.target.value || undefined })}
              className="h-8"
            />
          </label>
        </fieldset>
      </PopoverContent>
    </Popover>
  )
}

export function SearchFilters({
  state,
  facets,
  onChange,
  locale,
  dictionary: t,
}: {
  state: SearchUrlState
  facets: SearchFacets
  onChange: (next: SearchUrlState) => void
  locale: string
  dictionary: Dictionary
}) {
  const people: Option[] = facets.people.map((person) => ({
    value: person.email || person.name,
    label: person.name || person.email || "",
    hint: String(person.count),
  }))
  const rooms: Option[] = facets.rooms.map((room) => ({ value: room.id, label: room.name }))
  const tags: Option[] = facets.tags.map((tag) => ({ value: tag, label: tag }))
  const types: Option[] = facets.meetingTypes.map((type) => ({ value: type, label: meetingTypeLabel(type, locale) }))

  return (
    <div role="group" aria-label={t.searchFilters} className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <DateFilter state={state} onChange={onChange} dictionary={t} />
        <MultiSelect
          label={t.searchPeople}
          options={people}
          selected={state.participants}
          onChange={(participants) => onChange({ ...state, participants })}
          dictionary={t}
          filterable
        />
        <MultiSelect
          label={t.searchRooms}
          options={rooms}
          selected={state.rooms}
          onChange={(next) => onChange({ ...state, rooms: next })}
          dictionary={t}
          filterable
        />
        <MultiSelect
          label={t.searchTags}
          options={tags}
          selected={state.tags}
          onChange={(next) => onChange({ ...state, tags: next })}
          dictionary={t}
          filterable
        />
        {types.length || state.meetingTypes.length ? (
          <MultiSelect
            label={t.searchMeetingType}
            options={types}
            selected={state.meetingTypes}
            onChange={(meetingTypes) => onChange({ ...state, meetingTypes })}
            dictionary={t}
          />
        ) : null}
        <span aria-hidden className="mx-1 h-4 w-px bg-line" />
        <div role="group" aria-label={t.searchLanguage} className="flex flex-wrap gap-1">
          {SEARCH_LANGUAGES.map((language) => {
            const on = state.languages.includes(language)

            return (
              <button
                key={language}
                type="button"
                aria-pressed={on}
                onClick={() => onChange({ ...state, languages: toggleListValue(state.languages, language) })}
                className={cn(chip, on ? chipOn : chipOff)}
              >
                {t[LANGUAGE_KEYS[language]]}
              </button>
            )
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-fg-3">{t.searchKinds}</span>
        {SEARCH_KINDS.map((kind) => {
          const on = state.kinds.includes(kind)

          return (
            <button
              key={kind}
              type="button"
              aria-pressed={on}
              onClick={() => onChange({ ...state, kinds: toggleListValue(state.kinds, kind) })}
              className={cn(chip, on ? chipOn : chipOff)}
            >
              {t[KIND_KEYS[kind]]}
            </button>
          )
        })}
        {hasActiveFilters(state) ? (
          <Button size="xs" variant="ghost" className="ms-auto" onClick={() => onChange(clearFilters(state))}>
            <XIcon data-icon="inline-start" />
            {t.searchClearAll}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
