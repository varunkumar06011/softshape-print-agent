import pandas as pd

# Read Excel
df = pd.read_excel('RATES_BAR.xlsx', header=None)

# Row 2 (index 2) contains venue names
# Row 3 onwards contains item data
item_rows = df.iloc[3:]

# Column mapping based on user's requirements:
# Column 4: Bar Ac Hall → Bar Hall
# Column 5: Conference Hall → Conference Hall
# Column 6: CONFERENCE 2 → PDR
# Column 7: pdr → Rooms
# Column 10: parcel → Parcel

csv_data = []
for _, row in item_rows.iterrows():
    item_id = str(row[0]).strip() if pd.notna(row[0]) else ''
    item_name = str(row[1]).strip() if pd.notna(row[1]) else ''
    
    if not item_name or item_name == 'nan':
        continue
    
    # Extract prices from Excel columns
    bar_price = row[4] if pd.notna(row[4]) else 0
    conf_price = row[5] if pd.notna(row[5]) else 0
    pdr_price = row[6] if pd.notna(row[6]) else 0  # CONFERENCE 2 → PDR
    rooms_price = row[7] if pd.notna(row[7]) else 0  # pdr → Rooms
    parcel_price = row[10] if pd.notna(row[10]) else 0
    
    # Convert to numbers
    try:
        bar_price = float(bar_price)
        conf_price = float(conf_price)
        pdr_price = float(pdr_price)
        rooms_price = float(rooms_price)
        parcel_price = float(parcel_price)
    except (ValueError, TypeError):
        continue
    
    # Only include if at least one price > 0
    if bar_price > 0 or conf_price > 0 or pdr_price > 0 or rooms_price > 0 or parcel_price > 0:
        csv_line = f"{item_name},{bar_price},{conf_price},{pdr_price},{rooms_price},{parcel_price}"
        csv_data.append(csv_line)

# Write to CSV
with open('bar_menu_from_excel.csv', 'w', encoding='utf-8') as f:
    f.write('\n'.join(csv_data))

print(f"✅ Converted {len(csv_data)} items to bar_menu_from_excel.csv")
print("CSV format: name, barPrice, confPrice, pdrPrice, roomsPrice, parcelPrice")