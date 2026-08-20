/**
 * Definición de campos del formulario por categoría — espejo UI del schema
 * zod autoritativo (linear-lighting/shared/src/catalog-types.ts). La
 * validación estricta ocurre en el sync del backend Linear Lighting; este
 * archivo sólo define qué se muestra y cómo se parsea.
 */

export const LL_CATEGORIES = [
    { key: "strip", label: "LED Strips" },
    { key: "driver", label: "Drivers" },
    { key: "sensor", label: "Sensors" },
    { key: "switch", label: "Switches" },
    { key: "cable", label: "Cables / Extensions" },
    { key: "connector", label: "Connectors" },
    { key: "accessory", label: "Accessories" },
] as const;

export type LlCategoryKey = (typeof LL_CATEGORIES)[number]["key"];

export interface FieldDef {
    key: string;
    label: string;
    type: "text" | "number" | "select";
    options?: readonly { value: string; label: string }[];
    required?: boolean;
    help?: string;
}

const COMMON_FIELDS: FieldDef[] = [
    { key: "friendly_name", label: "Calculator Friendly Name", type: "text", help: "Lo que ve el cliente (ej. “Bright Light”). Si falta, se muestra el título del producto." },
    {
        key: "voltage",
        label: "Voltage",
        type: "select",
        options: [
            { value: "12", label: "12V" },
            { value: "24", label: "24V" },
            { value: "120", label: "120V" },
        ],
    },
    { key: "diagram_image_url", label: "Diagram Photo URL", type: "text", help: "Foto para el diagrama de conexión. IZQUIERDA = input, DERECHA = output." },
    { key: "sort_order", label: "Sort Order", type: "number" },
    { key: "notes", label: "Notes", type: "text" },
];

const FIELDS_BY_CATEGORY: Record<LlCategoryKey, FieldDef[]> = {
    strip: [
        { key: "watts_per_ft", label: "Watts per Foot", type: "number", required: true },
        { key: "cut_increment_in", label: "Cut Increment (in)", type: "number", required: true },
        { key: "roll_length_in", label: "Roll Length (in)", type: "number", required: true, help: "Ej. 196 = 16ft 4in" },
        { key: "max_run_in", label: "Max Run per Output (in)", type: "number" },
        {
            key: "color_type",
            label: "Color Type",
            type: "select",
            options: [
                { value: "single", label: "Single color" },
                { value: "cct", label: "CCT (tunable white)" },
                { value: "rgb", label: "RGB" },
                { value: "rgbw", label: "RGBW" },
            ],
        },
        { key: "connector_type", label: "Connector Type", type: "text", help: "Ej. JST-SM-2pin" },
        { key: "lumens_per_ft", label: "Lumens per Foot", type: "number" },
        { key: "strip_width_mm", label: "Strip Width (mm)", type: "number" },
    ],
    driver: [
        {
            key: "voltage_out",
            label: "Output Voltage",
            type: "select",
            required: true,
            options: [
                { value: "12", label: "12V" },
                { value: "24", label: "24V" },
            ],
        },
        { key: "rated_watts", label: "Rated Watts", type: "number", required: true },
        { key: "usable_watts", label: "Usable Watts (override)", type: "number", help: "Si falta: 90% del rated (Class 2: 94-98W → 90W)." },
        { key: "utilization_pct", label: "Utilization % (0-1)", type: "number" },
        { key: "outputs", label: "Direct Outputs", type: "number" },
        {
            key: "dimmable_type",
            label: "Dimming",
            type: "select",
            options: [
                { value: "non-dim", label: "Non-dim" },
                { value: "0-10v", label: "0-10V" },
                { value: "triac", label: "TRIAC" },
                { value: "controller", label: "Controller" },
            ],
        },
        { key: "input_connector", label: "Input Connector", type: "text" },
        { key: "output_connector", label: "Output Connector", type: "text", help: "Ej. XJST-2pin" },
    ],
    sensor: [
        {
            key: "control_type",
            label: "Sensor Type",
            type: "select",
            required: true,
            options: [
                { value: "door", label: "Door sensor" },
                { value: "motion", label: "Motion sensor" },
                { value: "touch", label: "Touch sensor" },
                { value: "dimmer", label: "Dimmer" },
                { value: "other", label: "Other" },
            ],
        },
        { key: "max_load_watts", label: "Max Load (W)", type: "number" },
        { key: "input_connector", label: "Input Connector", type: "text" },
        { key: "output_connector", label: "Output Connector", type: "text" },
    ],
    switch: [
        {
            key: "control_type",
            label: "Switch Type",
            type: "select",
            required: true,
            options: [
                { value: "touch", label: "Touch switch" },
                { value: "dimmer", label: "Dimmer" },
                { value: "manual", label: "Manual switch" },
                { value: "other", label: "Other" },
            ],
        },
        { key: "max_load_watts", label: "Max Load (W)", type: "number" },
        { key: "input_connector", label: "Input Connector", type: "text" },
        { key: "output_connector", label: "Output Connector", type: "text" },
    ],
    cable: [
        { key: "length_in", label: "Length (in)", type: "number", required: true },
        { key: "connector_type", label: "Connector Type", type: "text" },
    ],
    connector: [
        {
            key: "accessory_type",
            label: "Connector Type",
            type: "select",
            required: true,
            options: [
                { value: "splitter", label: "Splitter / Distribution" },
                { value: "joiner", label: "Joiner" },
                { value: "corner", label: "Corner" },
                { value: "end_cap", label: "End cap" },
                { value: "lever_nut", label: "Lever nut" },
                { value: "splice", label: "Splice" },
                { value: "other", label: "Other" },
            ],
        },
        { key: "outputs", label: "Outputs (splitters)", type: "number" },
        { key: "input_connector", label: "Input Connector", type: "text" },
        { key: "output_connector", label: "Output Connector", type: "text" },
    ],
    accessory: [
        {
            key: "accessory_type",
            label: "Accessory Type",
            type: "select",
            required: true,
            options: [
                { value: "mounting", label: "Mounting" },
                { value: "other", label: "Other" },
            ],
        },
        { key: "input_connector", label: "Input Connector", type: "text" },
        { key: "output_connector", label: "Output Connector", type: "text" },
    ],
};

export function fieldsFor(category: LlCategoryKey): FieldDef[] {
    return [...COMMON_FIELDS, ...FIELDS_BY_CATEGORY[category]];
}

/** Parsea el estado del form (strings) al objeto metadata tipado por campo. */
export function parseFormValues(
    category: LlCategoryKey,
    systems: string[],
    values: Record<string, string>
): Record<string, unknown> {
    const out: Record<string, unknown> = { category, systems };
    for (const field of fieldsFor(category)) {
        const raw = values[field.key];
        if (raw === undefined || raw === "") continue;
        if (field.type === "number") {
            const n = Number(raw);
            if (!Number.isNaN(n)) out[field.key] = n;
        } else if (field.type === "select" && /^\d+$/.test(raw) && (field.key === "voltage" || field.key === "voltage_out")) {
            out[field.key] = Number(raw);
        } else {
            out[field.key] = raw;
        }
    }
    return out;
}

/** Estado inicial del form desde metadata existente. */
export function toFormValues(meta: Record<string, unknown> | null | undefined): Record<string, string> {
    const values: Record<string, string> = {};
    if (!meta) return values;
    for (const [k, v] of Object.entries(meta)) {
        if (typeof v === "string" || typeof v === "number") values[k] = String(v);
    }
    return values;
}
