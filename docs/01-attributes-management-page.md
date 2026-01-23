# Attributes Management Page (Admin UI)

> [!NOTE]
> This document details the implementation of the main **Attributes Dashboard** located at `/app/attributes`, which serves as the central hub for organizing product specifications.

---

## 1. Overview
The **Attributes Management Page** (`src/admin/routes/attributes/page.tsx`) allows admins to create, organize, and manage product attributes (e.g., Color, Size, Material) and group them into **Attribute Sets** (e.g., "Electrical Specs", "Physical Dimensions").

## 2. Key Features

### A. Accordion-Based Organization
- **Sets as Containers**: Attributes are visually grouped into collapsible accordions representing "Attribute Sets".
- **Unassigned Attributes**: A special, always-present group collects attributes that haven't been categorized yet, ensuring nothing gets lost.
- **State Persistence**: The expanded/collapsed state of accordions is managed locally (`expandedSets` Set) for a smooth browsing experience.

### B. Bulk Actions
- **Multi-Select**: Users can select multiple attributes across different sets using checkboxes.
- **Bulk Move**: A "Move to:" dropdown appears when items are selected, allowing admins to reassign multiple attributes to a specific Set (or back to Unassigned) in a single action.
- **Select All**: Each accordion has a "Select All" helper to quickly grab all attributes within that group.

### C. Search & Filter
- **Real-time Search**: A global search bar filters attributes across *all* sets simultaneously.
- **Context-Aware Visibility**: If a Set contains no attributes matching the search query, the entire Set is hidden to reduce clutter.

### D. Modal Interactions
The page acts as a controller for several specialized modals:
- **Create Attribute**: Defines a new attribute key (code, label).
- **Create Set**: Establishes a new group.
- **Rename Set** & **Delete Set**: accessible via hover actions on the accordion headers.

---

## 3. Technical Implementation

### Data Fetching
- **React Query**: Uses `useQuery` to fetch `['attributes']` and `['attribute-sets']` in parallel.
- **Optimistic UI**: The UI reacts immediately to local state changes (selection) while invalidate queries refresh data after mutations (like Bulk Move).

### Component Structure
- **Route**: `src/admin/routes/attributes/page.tsx` (Main Controller)
- **Modals**:
    - `src/admin/components/attributes/create-attribute-modal.tsx`
    - `src/admin/components/attributes/create-set-modal.tsx`
    - `src/admin/components/attributes/rename-set-modal.tsx`
    - `src/admin/components/attributes/delete-set-modal.tsx`

### Data Model Relations
- **Attribute Key**: The core entity (e.g., "Width").
- **Attribute Set**: A grouping container.
- **Relationship**: One-to-Many (One Set can have many Keys; a Key belongs to one Set or none).

---

> [!TIP]
> **Future Enhancement**: Currently, drag-and-drop reordering is not implemented but is a frequent request. The `bulk-move` endpoint structure is already compatible with such a feature.
