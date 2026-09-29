# Writes fixtures/overture/places-mini.parquet: Overture's places schema (the columns OutRN reads),
# two row groups, zstd. The first group is on the Lower East Side, the second in London, so a read of
# an LES box must skip it by its bbox statistics.
import pyarrow as pa, pyarrow.parquet as pq, sys
src = pa.struct([("property", pa.string()), ("dataset", pa.string()), ("license", pa.string()), ("update_time", pa.string()), ("confidence", pa.float64())])
schema = pa.schema([
  ("id", pa.string()),
  ("names", pa.struct([("primary", pa.string())])),
  ("bbox", pa.struct([("xmin", pa.float32()), ("xmax", pa.float32()), ("ymin", pa.float32()), ("ymax", pa.float32())])),
  ("confidence", pa.float64()),
  ("websites", pa.list_(pa.string())),
  ("phones", pa.list_(pa.string())),
  ("operating_status", pa.string()),
  ("basic_category", pa.string()),
  ("sources", pa.list_(src)),
])
def box(lon, lat): return {"xmin": lon, "xmax": lon, "ymin": lat, "ymax": lat}
def s(dataset, license="CDLA-Permissive-2.0", t="2026-08-01T12:00:00Z", c=None, prop=""): return {"property": prop, "dataset": dataset, "license": license, "update_time": t, "confidence": c}
signal = s("Overture-signals", t="2026-06-26T16:25:14Z", c=1.0, prop="/properties/operating_status")
les = [
  {"id": "ovt-grand", "names": {"primary": "Grand Kitchen"}, "bbox": box(-73.99268, 40.72698), "confidence": 0.95, "websites": ["https://grandkitchen.example.com/"], "phones": ["2125550100"], "operating_status": "open", "basic_category": "restaurant", "sources": [s("meta", t="2026-09-01T00:00:00Z"), signal]},
  {"id": "ovt-dentist", "names": {"primary": "Grand Dental"}, "bbox": box(-73.99270, 40.72700), "confidence": 0.9, "websites": None, "phones": None, "operating_status": "open", "basic_category": "dental_clinic", "sources": [s("meta")]},
  {"id": "ovt-fsq", "names": {"primary": "Broome Kitchen NYC"}, "bbox": box(-73.98590, 40.72663), "confidence": 0.85, "websites": None, "phones": ["+1 (212) 555-0142"], "operating_status": "open", "basic_category": "casual_eatery", "sources": [s("Foursquare", license="Apache-2.0")]},
  {"id": "ovt-odbl", "names": {"primary": "Hester Kitchen"}, "bbox": box(-73.98160, 40.72630), "confidence": 0.9, "websites": None, "phones": None, "operating_status": "open", "basic_category": "restaurant", "sources": [s("someone", license="ODbL-1.0")]},
  {"id": "ovt-noname", "names": None, "bbox": box(-73.98700, 40.72400), "confidence": 0.5, "websites": None, "phones": None, "operating_status": None, "basic_category": "bar", "sources": []},
  {"id": "ovt-outside", "names": {"primary": "Far Kitchen"}, "bbox": box(-73.90000, 40.80000), "confidence": 0.9, "websites": None, "phones": None, "operating_status": "open", "basic_category": "restaurant", "sources": [s("meta")]},
]
london = [
  {"id": "ovt-london", "names": {"primary": "Borough Kitchen"}, "bbox": box(-0.0907, 51.5055), "confidence": 0.9, "websites": None, "phones": None, "operating_status": "open", "basic_category": "restaurant", "sources": [s("meta")]},
  {"id": "ovt-london-2", "names": {"primary": "Thames Bar"}, "bbox": box(-0.1, 51.5), "confidence": 0.9, "websites": None, "phones": None, "operating_status": "open", "basic_category": "bar", "sources": [s("meta")]},
]
t = pa.Table.from_pylist(les + london, schema=schema)
pq.write_table(t, sys.argv[1], row_group_size=len(les), compression="zstd", write_statistics=True)
md = pq.ParquetFile(sys.argv[1]).metadata
print(md.num_row_groups, [md.row_group(i).num_rows for i in range(md.num_row_groups)])
