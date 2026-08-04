import pandas as pd

df = pd.read_excel('RATES_BAR.xlsx', header=None)

print("=== First 10 rows ===")
for i in range(10):
    print(f"\nRow {i}:")
    print(df.iloc[i].tolist())

print("\n=== Column count ===")
print(f"Total columns: {len(df.columns)}")

print("\n=== Row 1 (header row with venue names) ===")
print(df.iloc[1].tolist())

print("\n=== Row 2 (first item row) ===")
print(df.iloc[2].tolist())

print("\n=== Unique non-null values in column 4 (first price column) ===")
print(df.iloc[:, 4].dropna().unique()[:20])
