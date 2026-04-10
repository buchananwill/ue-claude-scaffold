---
name: ue-slate
description: Domain knowledge for UE Slate — the C++ UI DSL, style registration system, widget ownership model, and common footguns. Use when an agent reads, reviews, or documents Slate code.
axis: domain
---

# UE Slate Domain Knowledge

Slate is Unreal Engine's C++ immediate-mode-style UI framework. It uses a fluent declarative syntax for widget construction and a name-keyed style registration system for theming.

## Widget Construction

Widgets are built with `SNew(SMyWidget)` (returns `TSharedRef<SMyWidget>`) or `SAssignNew(Ptr, SMyWidget)` (also assigns to an external `TSharedPtr`). Arguments are declared in the widget class via macros:

- `SLATE_ARGUMENT(Type, Name)` — value-only, stored directly
- `SLATE_ATTRIBUTE(Type, Name)` — `TAttribute<Type>`, accepts value or delegate/lambda
- `SLATE_EVENT(DelegateType, Name)` — delegate binding
- `SLATE_STYLE_ARGUMENT(StyleType, Name)` — `const StyleType*`, raw pointer to a style struct from a registered style set

Compound widgets own a single `ChildSlot` populated via `operator[]`. Panel widgets (`SVerticalBox`, `SHorizontalBox`, etc.) use `AddSlot()` / `operator+`.

## Style System

### Registration

`FSlateStyleSet` implements `ISlateStyle`. A module registers its styles at startup:

1. Construct: `FSlateStyleSet StyleSet(FName("MyStyleName"))`
2. Set content root: `SetContentRoot(...)` — base path for brush macros (`IMAGE_BRUSH`, `BOX_BRUSH`, etc.)
3. Populate: `Set(FName, ...)` overloads for brushes, fonts, colors, margins, floats, sounds, and `FSlateWidgetStyle` subclasses
4. Register: `FSlateStyleRegistry::RegisterSlateStyle(StyleSet)`
5. Unregister in `ShutdownModule()` — the style set must outlive all widgets referencing it

### Lookup

`ISlateStyle` provides typed getters keyed by `FName`:

- `GetBrush` / `GetOptionalBrush` — `GetBrush` logs a warning and returns a pink placeholder on miss; `GetOptionalBrush` returns a default silently
- `GetFontStyle`, `GetColor`, `GetSlateColor`, `GetMargin`, `GetFloat`, `GetSound`
- `GetWidgetStyle<T>(Name)` / `HasWidgetStyle<T>(Name)` — templated on `FSlateWidgetStyle` subclasses

All getters accept an optional `Specifier` string that is appended to the name, enabling style variants (e.g. `"Button.Primary"`, `"Button.Danger"`).

Parent style fallback (`SetParentStyleName`) resolves at query time via `FSlateStyleRegistry`. If the parent isn't registered yet, fallback silently returns nothing.

### Global Access

- `FSlateStyleRegistry::FindSlateStyle(FName)` — returns `const ISlateStyle*` or nullptr
- `FAppStyle::Get()` — the application-wide default style set

## Widget Ownership

- `TSharedRef<SWidget>` / `TSharedPtr<SWidget>` are the ownership primitives. A widget held only in a parent slot is destroyed with the parent.
- An external `TSharedPtr` kept after parent destruction points to a widget that may have been removed from the tree — it won't null out automatically. Use `SAssignNew` deliberately when you need to retain a handle.
- `SLATE_STYLE_ARGUMENT` stores a raw `const*` to the style struct. The pointed-to memory must be owned by a live registered style set for the widget's entire lifetime.

## Footguns

- **Name typos are silent runtime failures.** Style lookups are string-keyed with no compile-time validation. A mistyped name returns a pink placeholder brush or zero-value default with only a log warning.
- **Registration ordering matters.** Styles must be registered before any widget that references them is constructed. Module startup order is the typical failure point.
- **Brush ownership is caller-new.** `Set(FName, new IMAGE_BRUSH(...))` stores the raw pointer. If the style set is destroyed while widgets still reference the brush, the next paint frame crashes.
- **`FVector2D` is deprecated** for brush size arguments. Use `FVector2f`.
