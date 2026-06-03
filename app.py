import csv
import re

INPUT = "odpowiedzi.csv"
OUTPUT = "odpowiedzi_clean.csv"

rows = []

with open(INPUT, newline="", encoding="utf-8") as f:
    reader = csv.reader(f, delimiter=";")
    header = next(reader)

    for row in reader:
        if len(row) < 2:
            continue

        text = row[1]

        # NORMALIZACJA SPACJI (taby, wiele spacji, nowe linie)
        text = re.sub(r"\s+", " ", text).strip()

        rows.append(text)

# ZAPIS + NOWA NUMERACJA
with open(OUTPUT, "w", newline="", encoding="utf-8") as f:
    writer = csv.writer(f, delimiter=";")
    writer.writerow(["ID", "Odpowiedzi"])

    for i, text in enumerate(rows, start=1):
        writer.writerow([i, text])

print(f"Gotowe. Zapisano {len(rows)} rekordów do {OUTPUT}")