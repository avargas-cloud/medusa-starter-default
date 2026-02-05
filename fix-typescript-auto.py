#!/usr/bin/env python3
"""
Automated TypeScript error fixer for Railway deployment
Applies common fix patterns across multiple files
"""

import re
from pathlib import Path

BACKEND_DIR = Path("/home/alejo/ecopowertech-website/backend/src")

# Pattern 1: Add parameter validation for req.params.id
def add_param_validation(file_path: Path, param_name: str = "id"):
    content = file_path.read_text()
    
    # Find functions that use req.params.{param_name}
    pattern = rf"(async function \w+\([^)]*req[^)]*\)\s*{{)"
    
    validation_code = f"""
    if (!req.params.{param_name}) {{
        return res.status(400).json({{ error: "{param_name} parameter is required" }})
    }}
    """
    
    # Add validation after function opening brace
    # This is simplified - would need more sophisticated AST parsing for production
    return content

# Pattern  2: Add null checks for possibly undefined objects
def add_null_checks(content: str, var_name: str):
    # Add if (!var_name) check before first usage
    pattern = rf"(\s+)(const \w+ = {var_name}\.)"
    replacement = rf"\1if (!{var_name}) {{\n\1    return res.status(404).json({{ error: \"{var_name} not found\" }})\n\1}}\n\1\2"
    return re.sub(pattern, replacement, content, count=1)

# Pattern 3: Add explicit return for endpoints
def add_explicit_returns(content: str):
    # Add return statement before res.json/res.status calls
    content = re.sub(r"(\s+)(res\.(json|status|send))", r"\1return \2", content)
    return content

# Pattern 4: Fix implicit any in callbacks
def fix_implicit_any(content: str):
    # Add type annotations to common callback parameters
    replacements = [
        (r"\.map\((\w+) =>", r".map((\1: any) =>"),
        (r"\.filter\((\w+) =>", r".filter((\1: any) =>"),
        (r"\.find\((\w+) =>", r".find((\1: any) =>"),
        (r"\.reduce\(\((\w+), (\w+)\) =>", r".reduce(((\1: any, \2: any)) =>"),
    ]
    
    for pattern, replacement in replacements:
        content = re.sub(pattern, replacement, content)
    
    return content

# Pattern 5: Fix error type from unknown
def fix_error_types(content: str):
    # Change: error.message when error is unknown 
    # To: (error as Error).message
    content = re.sub(
        r"catch \(error\) \{([^}]*?)error\.message",
        r"catch (error) {\1(error as Error).message",
        content,
        flags=re.DOTALL
    )
    return content

if __name__ == "__main__":
    print("🔧 Automated TypeScript Fixer")
    print("=" * 50)
    
    # This script demonstrates the patterns
    # Full implementation would apply these systematically
    print("Patterns ready to apply:")
    print("1. Parameter validation")
    print("2. Null checks")
    print("3. Explicit returns")
    print("4. Type annotations")
    print("5. Error type fixes")
