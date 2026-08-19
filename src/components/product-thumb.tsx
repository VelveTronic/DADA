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
 * 44px, the design's thumbnail. It was 48px, and the four pixels went to the
 * product NAME: the catalogue is a two-pane screen now, so on a 390px phone the
 * row is drawn in the ~300px left over beside the category rail, and every
 * pixel not spent on the photo is a pixel the title can wrap into. Still big
 * enough to recognise a jar of sauce at arm's length.
 *
 * It is handed to `next/image` as the LAYOUT width, not a doubled one: with no
 * `sizes` prop Next emits a 1x/2x srcSet from it — each of 44 and 88 rounded UP
 * to the next configured image size, so 48w and 96w. The 48px box this row used
 * to draw asked for the same pair, which is why shrinking to 44 changed no
 * bytes: `imageSizes` defaults to `[32, 48, 64, 96, 128, 256, 384]`
 * (`node_modules/next/dist/shared/lib/image-config.js:41`, and `next.config.ts`
 * does not override it), so 44 and 88 round to 48 and 96 exactly as 48 and 96
 * did. `sizes` is for `fill` or CSS-responsive images and would replace those
 * two candidates with the whole 32w…3840w ladder on every row
 * (`node_modules/next/dist/docs/01-app/03-api-reference/02-components/image.md`).
 * Loading stays lazy, which is `next/image`'s default.
 */
const THUMB_PX = 44;

/**
 * …and 50px, the ONE other size the design draws it at: the three-photo strip on
 * an order card (design 06), where the picture is the whole of what identifies a
 * past order at a glance and there is no product name beside it to help.
 *
 * It costs one more pair of candidates from the optimizer — 50 and 100 round UP
 * to the configured 64 and 128 (see the note above), against 48/96 for the 44px
 * row — which is why it is a second size rather than a new single size for
 * everything.
 */
const THUMB_LG_PX = 50;

export type ThumbSize = typeof THUMB_PX | typeof THUMB_LG_PX;

/**
 * The box itself, shared by the photo and the empty slot so a product without
 * one keeps its row aligned with every other row. The classes ARE the two
 * constants above — Tailwind cannot read them, so the pairs are kept next to
 * each other and nothing else in the portal names a thumbnail size.
 */
const THUMB_BOX = "shrink-0 rounded-lg border border-border bg-border";
const THUMB_BOX_SIZE: Record<ThumbSize, string> = {
  [THUMB_PX]: "size-11",
  [THUMB_LG_PX]: "size-[50px]",
};

export function ProductThumb({
  src,
  size = THUMB_PX,
}: {
  src: string | null | undefined;
  /** 44px in every product LIST; 50px on the order card's photo strip. */
  size?: ThumbSize;
}) {
  const box = `${THUMB_BOX} ${THUMB_BOX_SIZE[size]}`;

  // A plain neutral square for the handful of products the freepos library has
  // no file for. Deliberately wordless: an "sin imagen" label would be one more
  // string to carry in both languages for something the empty box already says.
  if (!src) return <div className={box} />;

  return (
    <Image
      src={src}
      alt=""
      width={size}
      height={size}
      // The freepos shots are not all square, so the box crops rather than
      // distorts. The tinted background shows through until the file lands.
      className={`${box} object-cover`}
    />
  );
}
