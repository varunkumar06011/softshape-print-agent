import pandas as pd

df = pd.read_excel('RATES_BAR.xlsx', header=None)

venues = df.iloc[2, 4:].tolist()
print('Venues in Excel:')
for i, v in enumerate(venues):
    print(f'  Column {i+4}: {v}')

print('\nSample items with prices:')
for i in range(3, 15):
    row = df.iloc[i]
    item_id = row[0]
    item_name = row[1]
    prices = row[4:].tolist()
    print(f'  {item_id} - {item_name}: {prices}')
