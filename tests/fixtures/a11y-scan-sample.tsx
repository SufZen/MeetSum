// Scanner fixture for tests/a11y-static.test.ts (not app code).
declare function XIcon(props: { "aria-hidden"?: boolean }): null

export function Sample({ onPick }: { onPick: () => void }) {
  return (
    <div>
      <button type="button">
        <XIcon aria-hidden />
      </button>
      <button type="button" aria-label="Close">
        <XIcon aria-hidden />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
      <img src="/a.png" />
      <div onClick={onPick}>pick</div>
      <div role="button" tabIndex={0} onClick={onPick} onKeyDown={onPick}>pick</div>
      <input />
      <label>
        Name <input />
      </label>
      <section role="dialog">dialog</section>
    </div>
  )
}
