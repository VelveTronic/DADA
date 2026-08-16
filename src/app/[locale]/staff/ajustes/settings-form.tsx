import { updateSetting } from "@/app/actions/staff-settings";
import { BTN_PRIMARY } from "@/components/ui";

/**
 * The 项目设置 card's one control: a switch and a save button.
 *
 * A Server Component with no state and no JavaScript. The switch is a real
 * `<input type="checkbox">` — screen readers, the keyboard and the browser's own
 * form restore all work because nothing here reimplements them — kept `sr-only`
 * with the visible track drawn by its sibling `<span>` through Tailwind's
 * `peer-checked:` variants. The knob is that span's `::after`, which is why it
 * can slide from a `peer-checked:` rule at all: only siblings of the checkbox
 * (and their pseudo-elements) are reachable from it.
 *
 * **The hidden `0` above the checkbox is load-bearing.** An off checkbox posts
 * nothing at all, so without it "hide prices" would arrive as an ABSENT field,
 * indistinguishable from a truncated request — and `parseSettingInput` refuses
 * to guess in the direction that hides every price from every restaurant. Both
 * inputs carry the same name; the action reads the LAST one (see `lastValue`).
 *
 * The value is not saved on the flip: settings that apply themselves as the
 * mouse passes over them are settings nobody dares touch. The owner presses
 * 保存, and the `?result=` banner says what happened.
 */
export function SettingsForm({
  locale,
  showPrices,
  labels,
}: {
  locale: string;
  /** The current stored value; the switch's starting position. */
  showPrices: boolean;
  labels: { showPrices: string; showPricesHint: string; save: string };
}) {
  return (
    <form action={updateSetting} className="mt-4">
      <input type="hidden" name="locale" value={locale} />
      {/* Which setting this form writes. The action proves it is a registered
          key before anything is upserted — a hidden field is client input. */}
      <input type="hidden" name="key" value="show_prices" />

      <label className="flex cursor-pointer items-start gap-3">
        <input type="hidden" name="value" value="0" />
        <input
          type="checkbox"
          name="value"
          value="1"
          defaultChecked={showPrices}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className="relative mt-0.5 inline-block h-6 w-11 shrink-0 rounded-full border border-border bg-white/70 transition-colors after:absolute after:top-1 after:left-1 after:h-4 after:w-4 after:rounded-full after:bg-muted after:transition-transform peer-checked:border-brand peer-checked:bg-brand peer-checked:after:translate-x-5 peer-checked:after:bg-white peer-focus-visible:ring-2 peer-focus-visible:ring-brand"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{labels.showPrices}</span>
          <span className="mt-0.5 block text-xs text-muted">
            {labels.showPricesHint}
          </span>
        </span>
      </label>

      <button type="submit" className={`mt-5 ${BTN_PRIMARY}`}>
        {labels.save}
      </button>
    </form>
  );
}
