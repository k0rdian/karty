# Karty Przeciwko Ludzkości - Wersja Online

Aplikacja webowa typu "Cards Against Humanity" stworzona w technologii Node.js + Socket.io.
Gra przeznaczona do instalacji na serwerze VPS oraz uruchamiania lokalnego.

## Wymagania

- Node.js (wersja 14 lub wyższa)
- NPM (zawarty w Node.js)

## Instalacja Lokalna (Testowanie)

1. **Sklonuj lub pobierz projekt** na swój dysk.
   
2. **Zainstaluj zależności**:
   Otwórz terminal w folderze projektu i wpisz:
   ```bash
   npm install
   ```

3. **Skonfiguruj środowisko**:
   Upewnij się, że plik `.env` istnieje i zawiera poprawne hasło (domyślnie `12345`).

4. **Uruchom serwer**:
   ```bash
   npm start
   ```
   Lub:
   ```bash
   node server.js
   ```

5. **Otwórz w przeglądarce**:
   Wejdź na adres: `http://localhost:3000`

## Instalacja na Serwerze VPS (karty.lifedigital.pl)

Aby uruchomić aplikację publicznie pod domeną `karty.lifedigital.pl`, wykonaj poniższe kroki na swoim serwerze VPS (np. Ubuntu).

### 1. Przygotowanie Serwera
Upewnij się, że masz zainstalowany Node.js oraz Nginx.

```bash
# Aktualizacja pakietów
sudo apt update
sudo apt install nodejs npm nginx
```

### 2. Przesłanie Plików
Prześlij pliki aplikacji na serwer (np. do katalogu `/var/www/karty`).
Możesz użyć `scp` lub `git`.

### 3. Instalacja i Uruchomienie Procesu
W katalogu aplikacji:
```bash
cd /var/www/karty
npm install
```

Zaleca się użycie `pm2` do zarządzania procesem Node.js, aby aplikacja działała w tle i restartowała się po awarii.

```bash
sudo npm install -g pm2
pm2 start server.js --name "karty-app"
pm2 save
pm2 startup
```

### 4. Konfiguracja Nginx (Reverse Proxy)
Skonfiguruj Nginx, aby kierował ruch z domeny `karty.lifedigital.pl` na port aplikacji (3000).

Edytuj plik konfiguracyjny:
```bash
sudo nano /etc/nginx/sites-available/karty.lifedigital.pl
```

Wklej poniższą konfigurację:

```nginx
server {
    listen 80;
    server_name karty.lifedigital.pl;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Aktywuj stronę i zrestartuj Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/karty.lifedigital.pl /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 5. Certyfikat SSL (Opcjonalnie, zalecane)
Jeśli używasz Certbot (Let's Encrypt):
```bash
sudo certbot --nginx -d karty.lifedigital.pl
```

## Zasady Gry

1. **Logowanie**: Wpisz hasło ustalone w `.env`.
2. **Lobby**: Wybierz pokój (1-5) i wpisz swoje imię.
3. **Start**: Pierwszy gracz w pokoju jest Liderem i może rozpocząć grę (przycisk "Rozpocznij Grę") oraz dodać Boty.
4. **Rozgrywka**:
   - Odliczanie 5 sekund.
   - Pojawia się czarna karta z pytaniem.
   - Gracze mają 30 sekund na wybranie najsmieszniejszej odpowiedzi z 7 kart na ręce.
   - Jeśli gracz nie wybierze, karta zostanie wybrana losowo.
5. **Ocenianie**:
   - Czar (Sędzia) - oznaczony pogrubieniem na liście - wybiera najlepszą odpowiedź spośród nadesłanych.
   - Autor zwycięskiej odpowiedzi otrzymuje punkt.
6. **Koniec**: Gra kończy się, gdy wyczerpie się pula pytań. Wygrywa osoba z największą liczbą punktów.

## Konfiguracja (Pliki .csv)
Pytania i odpowiedzi znajdują się w plikach `pytania.csv` i `odpowiedzi.csv` w głównym katalogu. Format to `ID;Treść`.
