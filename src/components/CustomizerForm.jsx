import { useMemo } from "react";

/**
 * CustomizerForm — Dynamic form matching Customily original order & behavior
 * 
 * KEY: Options/values are rendered by sort_id (matching Customily visual order).
 * No manual grouping — visibility engine handles show/hide.
 * 
 * Types per Blueprint §6.1:
 * - Swatch: image/color picker OR number picker (for product functions)
 * - Dropdown: select list
 * - Text Input: free text
 */

function compareBySortIdThenId(a, b) {
  const sa = Number.isFinite(Number(a?.sort_id)) ? Number(a.sort_id) : Number.MAX_SAFE_INTEGER;
  const sb = Number.isFinite(Number(b?.sort_id)) ? Number(b.sort_id) : Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;

  const ia = Number.isFinite(Number(a?.id)) ? Number(a.id) : Number.MAX_SAFE_INTEGER;
  const ib = Number.isFinite(Number(b?.id)) ? Number(b.id) : Number.MAX_SAFE_INTEGER;
  if (ia !== ib) return ia - ib;

  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

function resolveProductPickerFallbackLabel(val, idx) {
  if (val?.value !== undefined && val?.value !== null && String(val.value) !== "") {
    return String(val.value);
  }
  return String(idx + 1);
}

function resolveImageUrl(imagePath) {
  if (!imagePath) return "";
  return `/api/assets/image?path=${encodeURIComponent(String(imagePath))}`;
}

function isRequiredOption(option) {
  const raw = option?.required;
  return raw === true || raw === 1 || String(raw).toLowerCase() === "true";
}

function isImageUploadOption(option) {
  const t = String(option?.type || "").toLowerCase().replace(/\s+/g, "");
  return t === "imageupload";
}

function isCheckboxOption(option) {
  const t = String(option?.type || "").toLowerCase().replace(/\s+/g, "");
  return t === "checkbox";
}

function isCheckboxChecked(raw) {
  const v = String(raw ?? "");
  return v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

function resolveUploadValueUrl(uploadValue) {
  if (!uploadValue) return "";
  if (typeof uploadValue === "string") return uploadValue;
  return uploadValue?.url || uploadValue?.path || "";
}

function SwatchOption({ option, selectedValue, onSelect }) {
  const isProductPicker = option.functions?.some((f) => f.type === "product");
  const sortedValues = useMemo(
    () => [...(option.values || [])].sort(compareBySortIdThenId),
    [option.values]
  );

  if (isProductPicker) {
    return (
      <div className="number-grid">
        {sortedValues.map((val, idx) => (
          <div
            key={val.id}
            className={`number-item ${val.thumb_image ? "number-item-image" : ""} ${String(val.id) === String(selectedValue) ? "selected" : ""}`}
            onClick={() => onSelect(String(val.id))}
            title={val.tooltip || val.value || `Option ${idx + 1}`}
          >
            {val.thumb_image ? (
              <img
                src={resolveImageUrl(val.thumb_image)}
                alt={val.tooltip || val.value || `Option ${idx + 1}`}
                loading="lazy"
              />
            ) : (
              resolveProductPickerFallbackLabel(val, idx)
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="swatch-grid">
      {sortedValues.map((val) => (
        <div
          key={val.id}
          className={`swatch-item ${String(val.id) === String(selectedValue) ? "selected" : ""}`}
          onClick={() => onSelect(String(val.id))}
          title={val.value}
        >
          {val.thumb_image ? (
            <img src={resolveImageUrl(val.thumb_image)} alt={val.value} loading="lazy" />
          ) : val.bg_color ? (
            <div
              className="swatch-color"
              style={{
                backgroundColor: val.bg_color,
                opacity: val.bg_color_alpha ?? 1,
              }}
            />
          ) : (
            <div className="swatch-color swatch-text-only">
              <span className="swatch-label-center">{val.value}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DropdownOption({ option, selectedValue, onSelect }) {
  const sortedValues = useMemo(
    () => [...(option.values || [])].sort(compareBySortIdThenId),
    [option.values]
  );

  return (
    <select
      className="option-dropdown"
      value={selectedValue || ""}
      onChange={(e) => onSelect(e.target.value)}
      required={isRequiredOption(option)}
      aria-required={isRequiredOption(option)}
    >
      {!selectedValue && <option value="">Chọn...</option>}
      {sortedValues.map((val) => (
        <option key={val.id} value={String(val.id)}>
          {val.value}
        </option>
      ))}
    </select>
  );
}

function TextInputOption({ option, value, onChange }) {
  const maxLength = Number.isFinite(Number(option?.max_length))
    ? Number(option.max_length)
    : 20;
  const placeholder = option?.placeholder || option?.label || "Nhập tên...";
  const helpText = option?.help_text || "";

  return (
    <div>
      <input
        className="option-text-input"
        type="text"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        maxLength={maxLength}
        placeholder={placeholder}
        required={isRequiredOption(option)}
        aria-required={isRequiredOption(option)}
      />
      {helpText ? <div className="text-input-help">{helpText}</div> : null}
      <div className="text-input-hint">
        {(value || "").length}/{maxLength} ký tự
      </div>
    </div>
  );
}

function CheckboxOption({ option, checked, onChange }) {
  const cid = String(option.id);
  const inputId = `checkbox-input-${cid}`;
  const helpText = option?.help_text || "";

  return (
    <div className="checkbox-option">
      <label className="checkbox-row" htmlFor={inputId}>
        <input
          id={inputId}
          type="checkbox"
          checked={Boolean(checked)}
          onChange={(e) => onChange(Boolean(e.target.checked))}
        />
        {helpText ? <div className="text-input-help">{helpText}</div> : null}
      </label>

    </div>
  );
}

function ImageUploadOption({
  option,
  uploadValue,
  isEditing = false,
  uploading = false,
  onUpload,
  onClear,
  onActivateEdit,
}) {
  const cid = String(option.id);
  const inputId = `upload-input-${cid}`;
  const uploadedUrl = resolveUploadValueUrl(uploadValue);
  const uploadedName = uploadValue?.fileName || "";
  const helpText = option?.help_text || "";

  return (
    <div className="image-upload-box">
      <div className="image-upload-actions">
        <label
          htmlFor={inputId}
          className={`btn btn-ghost btn-sm upload-action ${uploading ? "disabled" : ""}`}
          aria-disabled={uploading ? "true" : "false"}
        >
          {uploading ? "Đang upload..." : uploadedUrl ? "Thay ảnh" : "Chọn ảnh"}
        </label>
        {uploadedUrl ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm upload-action"
            onClick={onClear}
            disabled={uploading}
          >
            Xóa ảnh
          </button>
        ) : null}
      </div>

      <input
        id={inputId}
        className="option-file-input"
        type="file"
        accept="image/*"
        disabled={uploading}
        onChange={(e) => {
          const file = e.target.files?.[0] || null;
          if (file) onUpload(file);
          e.target.value = "";
        }}
      />

      {uploadedUrl ? (
        <button
          type="button"
          className={`image-upload-preview upload-preview-trigger ${isEditing ? "is-editing" : ""}`}
          onClick={onActivateEdit}
          disabled={uploading}
          title="Click để bật chỉnh ảnh trên preview"
        >
          <img src={uploadedUrl} alt={uploadedName || option.label || "Uploaded image"} />
        </button>
      ) : (
        <div className="image-upload-empty">Chưa có ảnh được upload</div>
      )}

      {uploadedName ? <div className="text-input-hint">{uploadedName}</div> : null}
      {uploadedUrl ? (
        <div className="upload-editor-hint">
          {isEditing ? "Đang chỉnh: kéo trực tiếp trên preview để di chuyển/zoom ảnh." : "Click vào ảnh để bật chế độ chỉnh."}
        </div>
      ) : null}

      {helpText ? <div className="text-input-help">{helpText}</div> : null}
    </div>
  );
}

export default function CustomizerForm({
  options,
  visibleOptionIds,
  selections,
  textInputs,
  uploadInputs,
  focusedUploadOptionId,
  uploadingUploadOptionIds,
  onSelectionChange,
  onTextChange,
  onUploadChange,
  onUploadClear,
  onUploadActivate,
}) {
  // Build set of visible option IDs for fast lookup
  const visibleSet = useMemo(
    () => new Set(visibleOptionIds.map(String)),
    [visibleOptionIds]
  );

  // Filter visible options and keep deterministic Customily order (sort_id)
  const visibleOptions = useMemo(
    () =>
      options
        .filter((o) => visibleSet.has(String(o.id)) && !o.hide_visually)
        .sort(compareBySortIdThenId),
    [options, visibleSet]
  );

  return (
    <div className="options-panel">
      {visibleOptions.map((opt) => {
        const cid = String(opt.id);
        const selectedValue = selections[cid];
        const textValue = textInputs[cid];
        const uploadValue = uploadInputs?.[cid];
        const isEditing = String(focusedUploadOptionId || "") === cid;
        const uploading = Boolean(uploadingUploadOptionIds?.[cid]);
        const required = isRequiredOption(opt);

        return (
          <div
            key={opt.id}
            className="option-group"
          >
            <label className="option-label">
              {opt.label}
              {required ? <span className="required-marker">*</span> : null}
            </label>

            {opt.type === "Swatch" && (
              <SwatchOption
                option={opt}
                selectedValue={selectedValue}
                onSelect={(valCid) => onSelectionChange(String(opt.id), valCid)}
              />
            )}

            {opt.type === "Dropdown" && (
              <DropdownOption
                option={opt}
                selectedValue={selectedValue}
                onSelect={(valCid) => onSelectionChange(String(opt.id), valCid)}
              />
            )}

            {(opt.type === "Text Input" || opt.type === "TextInput") && (
              <TextInputOption
                option={opt}
                value={textValue}
                onChange={(text) => onTextChange(String(opt.id), text)}
              />
            )}

            {isCheckboxOption(opt) && (
              <CheckboxOption
                option={opt}
                checked={isCheckboxChecked(selectedValue)}
                onChange={(nextChecked) =>
                  onSelectionChange(String(opt.id), nextChecked ? "1" : "")
                }
              />
            )}

            {isImageUploadOption(opt) && (
              <ImageUploadOption
                option={opt}
                uploadValue={uploadValue}
                isEditing={isEditing}
                uploading={uploading}
                onUpload={(file) => onUploadChange(String(opt.id), file)}
                onClear={() => onUploadClear(String(opt.id))}
                onActivateEdit={() => onUploadActivate(String(opt.id))}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
