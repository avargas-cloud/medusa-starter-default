import {
  ProductShape,
  resolveVariantThumbnails,
} from "../resolve"

const img = (id: string, url: string) => ({ id, url })
const variant = (
  id: string,
  thumbnail: string | null,
  images: ReturnType<typeof img>[]
) => ({ id, thumbnail, images })

const product = (
  id: string,
  thumbnail: string | null,
  variants: ReturnType<typeof variant>[]
): ProductShape => ({ id, thumbnail, variants })

describe("resolveVariantThumbnails", () => {
  it("returns empty for single-variant products", () => {
    const p = product("p1", "generic.jpg", [
      variant("v1", null, [img("img1", "photo.jpg")]),
    ])
    expect(resolveVariantThumbnails(p)).toEqual([])
  })

  it("returns update for each variant with a unique image", () => {
    const p = product("p1", "generic.jpg", [
      variant("v1", null, [img("img1", "bronze.jpg"), img("shared", "shared.jpg")]),
      variant("v2", null, [img("img2", "graphite.jpg"), img("shared", "shared.jpg")]),
      variant("v3", null, [img("img3", "magnesium.jpg"), img("shared", "shared.jpg")]),
    ])
    const updates = resolveVariantThumbnails(p)
    expect(updates).toHaveLength(3)
    expect(updates).toEqual(
      expect.arrayContaining([
        { variantId: "v1", thumbnail: "bronze.jpg" },
        { variantId: "v2", thumbnail: "graphite.jpg" },
        { variantId: "v3", thumbnail: "magnesium.jpg" },
      ])
    )
  })

  it("returns empty when all images are shared across variants", () => {
    const p = product("p1", "generic.jpg", [
      variant("v1", null, [img("shared1", "photo1.jpg"), img("shared2", "photo2.jpg")]),
      variant("v2", null, [img("shared1", "photo1.jpg"), img("shared2", "photo2.jpg")]),
    ])
    expect(resolveVariantThumbnails(p)).toEqual([])
  })

  it("returns update only for the variant with a unique image (mixed case)", () => {
    const p = product("p1", "generic.jpg", [
      variant("v1", null, [img("shared", "shared.jpg")]),
      variant("v2", null, [img("shared", "shared.jpg")]),
      variant("v3", null, [img("unique3", "magnesium.jpg"), img("shared", "shared.jpg")]),
    ])
    const updates = resolveVariantThumbnails(p)
    expect(updates).toEqual([{ variantId: "v3", thumbnail: "magnesium.jpg" }])
  })

  it("skips variants where thumbnail is already correct", () => {
    const p = product("p1", "generic.jpg", [
      variant("v1", "bronze.jpg", [img("img1", "bronze.jpg")]),
      variant("v2", null, [img("img2", "graphite.jpg")]),
    ])
    const updates = resolveVariantThumbnails(p)
    expect(updates).toEqual([{ variantId: "v2", thumbnail: "graphite.jpg" }])
  })

  it("skips variants where unique image url matches product thumbnail", () => {
    const p = product("p1", "white.jpg", [
      variant("v1", null, [img("img1", "white.jpg")]),
      variant("v2", null, [img("img2", "black.jpg")]),
    ])
    const updates = resolveVariantThumbnails(p)
    expect(updates).toEqual([{ variantId: "v2", thumbnail: "black.jpg" }])
  })
})
