export const ASSET_PUBLIC_FIELD_DEFINITIONS = [
  { key: "label", label: "Label", column: "label" },
  { key: "asset_type", label: "Asset type", column: "asset_type" },
  { key: "return_reference", label: "Return reference", column: "return_reference" },
] as const;

export type AssetPublicFieldKey = (typeof ASSET_PUBLIC_FIELD_DEFINITIONS)[number]["key"];

export const ASSET_PUBLIC_FIELD_KEYS = ASSET_PUBLIC_FIELD_DEFINITIONS.map(
  (field) => field.key,
) as AssetPublicFieldKey[];

export function isAssetPublicFieldKey(value: string): value is AssetPublicFieldKey {
  return (ASSET_PUBLIC_FIELD_KEYS as string[]).includes(value);
}
