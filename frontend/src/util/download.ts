export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Day-first datetime for filenames: DD-MM-YYYY-HHmm. */
export function fileStamp(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}-${p(d.getHours())}${p(d.getMinutes())}`
}
