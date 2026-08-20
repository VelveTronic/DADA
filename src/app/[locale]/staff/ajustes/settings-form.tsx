import { updateSetting } from "@/app/actions/staff-settings";
import { BTN_PRIMARY } from "@/components/ui";
import type { SettingKey } from "@/lib/settings";

/**
 * One 项目设置 card's control: a switch and a save button.
 *
 * ONE setting per form, and that is the shape `updateSetting` is built around —
 * it parses a single `key` and a single `value`. Two switches sharing a form
 * would post two `key` fields and two `value` fields, and the action would write
 * whichever pair it happened to read; separate forms mean the owner's 保存 says
 * exactly which switch it saves, and a failure names that switch alone.
 *
 * A Server Component with no state and no JavaScript. The switch is a real
 * `<input type="checkbox">` — screen readers, the keyboard and the browser's own
 * form restore all work because nothing here reimplements them — kept `sr-only`
 * with the visible track drawn by its sibling `<span>` through Tailwind's
 * `peer-checked:` variants. The knob is that span's `::after`, which is why it
 * can slide from a `peer-checked:` rule at all: only siblings of the checkbox
 * (and their pseudo-elements) are reachable from it. That is also why the label
 * text is written BEFORE the checkbox and the track AFTER it: `peer-*` compiles
 * to the general sibling combinator, which only reaches FOLLOWING siblings.
 *
 * The row is the mockup's (`dada-staff-admin.dc.html:465-472`): the title and
 * its sentence on the left, the switch alone on the right. 保存 stays BELOW the
 * row and on the left — the mockup has no per-row button because it has one
 * global 保存修改 for the whole page, and this page does not (see the note on
 * `ajustes/page.tsx`).
 *
 * **The hidden `0` above the checkbox is load-bearing.** An off checkbox posts
 * nothing at all, so without it "hide prices" would arrive as an ABSENT field,
 * indistinguishable from a truncated request — and `parseSettingInput` refuses
 * to guess in the direction that hides something from every restaurant. Both
 * inputs carry the same name; the action reads the LAST one (see
 * `parseToggleFormData`).
 *
 * The value is not saved on the flip: settings that apply themselves as the
 * mouse passes over them are settings nobody dares touch. The owner presses
 * 保存, and the `?result=` banner says what happened.
 */
export function SettingsForm({
  locale,
  settingKey,
  checked,
  labels,
}: {
  locale: string;
  /** Which registry entry this form writes. Typed, so a typo is a build error. */
  settingKey: SettingKey;
  /** The current stored value; the switch's starting position. */
  checked: boolean;
  labels: { label: string; hint: string; save: string };
}) {
  return (
    <form action={updateSetting}>
      <input type="hidden" name="locale" value={locale} />
      {/* Which setting this form writes. The action proves it is a registered
          key before anything is upserted — a hidden field is client input, and
          this component's own type says nothing about the POST that arrives. */}
      <input type="hidden" name="key" value={settingKey} />

      <label className="flex cursor-pointer items-center gap-5">
        <span className="min-w-0">
          <span className="block text-[13.5px] font-semibold">
            {labels.label}
          </span>
          <span className="mt-[5px] block text-[12px] leading-relaxed text-muted">
            {labels.hint}
          </span>
        </span>

        <input type="hidden" name="value" value="0" />
        <input
          type="checkbox"
          name="value"
          value="1"
          defaultChecked={checked}
          className="peer sr-only"
        />
        {/* The mockup's switch, to the pixel (`:528-530`, the `toggle()` helper
            that builds every `trackStyle`/`knobStyle` in the file): a 44×26
            track at `padding:3px` holding a 20×20 white knob, `#E4DED8` off and
            `#E0231C` — the brand — on.
            `--color-border-strong` IS `#e4ded8` (`globals.css:50`) and
            `--color-brand` IS `#e0231c` (`:76`), so both fills are the tokens
            and neither is a literal.
            NO border, also the mockup's: the track is a fill, so the 3px insets
            below are measured from the border box and the travel arithmetic is
            the mockup's own rather than a border's worth off it.

            Knob travel = 44 − 20 − 3 − 3 = 18px → `after:translate-x-[18px]`,
            which lands the knob 3px from the right edge exactly as it rests 3px
            from the left. Vertically it is centred by the same 3: 3 + 20 + 3 =
            26. The fixture measures all four gaps in both states.

            The KNOB's colour is the one place this switch parts with the
            mockup, and it has to. There the knob is white in both positions,
            and white on the `#E4DED8` off track is 1.33:1 — under the 3:1 WCAG
            asks of a non-text control, which makes the off switch a track with
            nothing visible in it. So the knob is `--color-muted` off (#6e6760
            on #e4ded8 = 4.17:1) and the mockup's white on (#ffffff on #e0231c =
            4.74:1). One colour cannot serve both: white fails the off track and
            muted on brand is 1.17:1, worse. The mockup's drop shadow stays in
            both states.

            The state is still carried by the track's colour and the knob's
            POSITION — the two things that move — which is the switch every
            phone in the room draws; the knob's colour only makes sure the knob
            is one of the things you can see. */}
        <span
          aria-hidden="true"
          className="relative ml-auto inline-block h-[26px] w-11 shrink-0 rounded-full bg-border-strong transition-colors after:absolute after:top-[3px] after:left-[3px] after:h-5 after:w-5 after:rounded-full after:bg-muted after:shadow-[0_1px_3px_rgba(0,0,0,.2)] after:transition-[transform,background-color] peer-checked:bg-brand peer-checked:after:translate-x-[18px] peer-checked:after:bg-white peer-focus-visible:ring-2 peer-focus-visible:ring-brand"
        />
      </label>

      <button type="submit" className={`mt-5 ${BTN_PRIMARY}`}>
        {labels.save}
      </button>
    </form>
  );
}
