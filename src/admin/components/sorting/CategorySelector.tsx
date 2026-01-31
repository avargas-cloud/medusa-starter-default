import { Container, Heading, Text } from "@medusajs/ui"
import { useState, useEffect } from "react"

interface Category {
    id: string
    name: string
    parent_category_id: string | null
}

interface CategorySelectorProps {
    categories: Category[]
    selectedCategoryId?: string
    onSelectCategory: (categoryId: string) => void
}

/**
 * Category tree selector component
 * Displays categories in a hierarchical tree structure
 */
export function CategorySelector({
    categories,
    selectedCategoryId,
    onSelectCategory,
}: CategorySelectorProps) {
    const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())

    // Auto-expand path to selected category
    useEffect(() => {
        if (selectedCategoryId) {
            const pathToRoot = new Set<string>()
            let currentId: string | null = selectedCategoryId

            // Traverse up to root, collecting all parent IDs
            while (currentId) {
                const category = categories.find(c => c.id === currentId)
                if (category?.parent_category_id) {
                    pathToRoot.add(category.parent_category_id)
                    currentId = category.parent_category_id
                } else {
                    break
                }
            }

            setExpandedCategories(pathToRoot)
        }
    }, [selectedCategoryId, categories])

    // Build category tree
    const buildTree = (parentId: string | null): Category[] => {
        return categories.filter((cat) => cat.parent_category_id === parentId)
    }

    const toggleExpand = (categoryId: string) => {
        const newExpanded = new Set(expandedCategories)
        if (newExpanded.has(categoryId)) {
            newExpanded.delete(categoryId)
        } else {
            newExpanded.add(categoryId)
        }
        setExpandedCategories(newExpanded)
    }

    const renderCategory = (category: Category, level: number = 0) => {
        const children = buildTree(category.id)
        const hasChildren = children.length > 0
        const isExpanded = expandedCategories.has(category.id)
        const isSelected = selectedCategoryId === category.id

        return (
            <div key={category.id}>
                <div
                    className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-ui-bg-base-hover ${isSelected ? "bg-ui-bg-base-pressed" : ""
                        }`}
                    style={{ paddingLeft: `${level * 16 + 8}px` }}
                    onClick={() => onSelectCategory(category.id)}
                >
                    {hasChildren && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation()
                                toggleExpand(category.id)
                            }}
                            className="text-ui-fg-muted hover:text-ui-fg-base"
                        >
                            {isExpanded ? "▼" : "▶"}
                        </button>
                    )}
                    {!hasChildren && <span className="w-4" />}
                    <Text className="text-sm">{category.name}</Text>
                </div>
                {isExpanded &&
                    children.map((child) => renderCategory(child, level + 1))}
            </div>
        )
    }

    const rootCategories = buildTree(null)

    return (
        <Container className="h-full overflow-y-auto">
            <Heading level="h2" className="mb-4">
                Categories
            </Heading>
            <div className="space-y-1">
                {rootCategories.length === 0 ? (
                    <Text className="text-ui-fg-muted text-sm">
                        No categories found
                    </Text>
                ) : (
                    rootCategories.map((cat) => renderCategory(cat))
                )}
            </div>
        </Container>
    )
}
