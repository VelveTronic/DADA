import Image from "next/image";

/**
 * The product photo every list row carries — catalogue, cart and the staff
 * table — at one size and one radius, so the three views line up as one portal.
 *
 * `alt` is EMPTY on purpose, everywhere. The photo sits directly beside the
 * product's name, so an alt text would make a screen reader read that name
 * twice; the image decorates a row that already says what it is.
 */

/**
 * 48px. Big enough to recognise a jar of sauce on a phone, small enough that
 * fifty rows still leave the name the width it needs.
 *
 * It is handed to `next/image` as the LAYOUT width, not a doubled one: with no
 * `sizes` prop Next emits a 1x/2x srcSet from it (64w and 128w after rounding to
 * the configured image sizes), which is what the docs prescribe for a
 * fixed-size image — `sizes` is for `fill` or CSS-responsive images and would
 * replace those two candidates with the whole 16w…3840w ladder on every row
 * (`node_modules/next/dist/docs/01-app/03-api-reference/02-components/image.md`).
 * Loading stays lazy, which is `next/image`'s default.
 */
const THUMB_PX = 48;

/**
 * The box itself, shared by the photo and the empty slot so a product without
 * one keeps its row aligned with every other row. `size-12` IS `THUMB_PX` —
 * Tailwind cannot read the constant, so the two are kept next to each other.
 */
const THUMB_BOX = "size-12 shrink-0 rounded-lg border border-border bg-border";

export function ProductThumb({ src }: { src: string | null | undefined }) {
  // A plain neutral square for the handful of products the freepos library has
  // no file for. Deliberately wordless: an "sin imagen" label would be one more
  // string to carry in both languages for something the empty box already says.
  if (!src) return <div className={THUMB_BOX} />;

  return (
    <Image
      src={src}
      alt=""
      width={THUMB_PX}
      height={THUMB_PX}
      // The freepos shots are not all square, so the box crops rather than
      // distorts. The tinted background shows through until the file lands.
      className={`${THUMB_BOX} object-cover`}
    />
  );
}
