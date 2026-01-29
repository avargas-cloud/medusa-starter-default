import { ChevronDown, ChevronRight } from "@medusajs/icons"
import { Text, Badge } from "@medusajs/ui"
import { useState } from "react"

interface Category {
    id: string
    name: string
    handle: string
    parent_category_id: string | null
    metadata?: {
        available_attributes?: string[]
        filter_config?: {
            override_inheritance: boolean
            active_filters: string[]
        }
    }
}

interface CategoryTreeNodeProps {
    category: Category
    getChildren: (id: string) => Category[]
    selectedId: string | null
    onSelect: (id: string) => void
    hasConfig: boolean
    level?: number
}

export function CategoryTreeNode({
    category,
    getChildren,
    selectedId,
    onSelect,
    hasConfig,
    level = 0,
}: CategoryTreeNodeProps) {
    const [isExpanded, setIsExpanded] = useState(false)

    const children = getChildren(category.id)
    const hasChildren = children.length > 0
    const isSelected = selectedId === category.id

    return (
        <div>
            <div
                className={`
                    flex items-center gap-2 py-2 px-3 rounded-md cursor-pointer
                    hover:bg-ui-bg-subtle-hover transition-colors
                    ${isSelected ? "bg-ui-bg-component text-ui-fg-base font-medium" : ""}
                `}
                style={{ paddingLeft: `${level * 16 + 12}px` }}
                onClick={() => onSelect(category.id)}
            >
                {hasChildren && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            setIsExpanded(!isExpanded)
                        }}
                        className="text-ui-fg-subtle hover:text-ui-fg-base"
                    >
                        {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                )}
                {!hasChildren && <div className="w-4" />}

                <Text size="small" className="flex-1">
                    {category.name}
                </Text>

                {hasConfig && <Badge size="2xsmall" color="blue">●</Badge>}
            </div>

            {isExpanded && hasChildren && (
                <div>
                    {children.map((child) => (
                        <CategoryTreeNode
                            key={child.id}
                            category={child}
                            getChildren={getChildren}
                            selectedId={selectedId}
                            onSelect={onSelect}
                            hasConfig={!!child.metadata?.filter_config?.override_inheritance}
                            level={level + 1}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}
