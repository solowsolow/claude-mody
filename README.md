# claude-mody

Cztery mody do Claude Code po polsku. Każdy to plugin z modułem hooków, który dokłada coś do interfejsu albo zachowania Claude Code:

| mod | co robi |
|---|---|
| **usage-bar** | pasek nad polem promptu: stan cache promptu, zapełnienie kontekstu, limity 5h i tygodniowy, przycisk kompaktowania |
| **context-bar** | karta nad promptem z podziałem kontekstu na kategorie i progiem auto-kompaktowania |
| **radar-sesji** | linia nad promptem i panel `/sesje`: które inne sesje Claude na tym komputerze czekają na Ciebie |
| **collision-guard** | ostrzega, zanim Claude zmieni plik, który przed chwilą zmieniała inna sesja Claude |

Wymagany jest Claude Code 2.1.309 lub nowszy (mody testowano na 2.1.309–2.1.312, na macOS).

## Instalacja w Claude Code

Wklej poniższy tekst jako wiadomość w dowolnej sesji Claude Code, w terminalu albo w aplikacji desktopowej:

```text
Zainstaluj mi mody do Claude Code z publicznego repozytorium solowsolow/claude-mody.

1. Dodaj marketplace: claude plugin marketplace add solowsolow/claude-mody
2. Zainstaluj w zakresie user cztery mody, każdy osobnym poleceniem:
   claude plugin install usage-bar@claude-mody --scope user --config cacheTtl=60
   claude plugin install context-bar@claude-mody --scope user
   claude plugin install radar-sesji@claude-mody --scope user
   claude plugin install collision-guard@claude-mody --scope user --config windowMinutes=30
3. Sprawdź w ~/.claude/plugins/installed_plugins.json, że wszystkie cztery są zainstalowane, i podaj mi ich wersje.

Jeśli polecenie `claude` nie działa w terminalu, nie instaluj niczego innym sposobem, tylko powiedz mi, jak dodać marketplace w aplikacji.
Na koniec przypomnij mi, że mody zaczną działać od następnej nowej sesji.
```

Claude poprosi o zgodę na uruchomienie poleceń `claude plugin …`. To normalne: polecenia instalują pluginy na Twoim koncie.

### Bez Claude: z terminala

```bash
claude plugin marketplace add solowsolow/claude-mody
```

```bash
claude plugin install usage-bar@claude-mody --scope user --config cacheTtl=60
```

```bash
claude plugin install context-bar@claude-mody --scope user
```

```bash
claude plugin install radar-sesji@claude-mody --scope user
```

```bash
claude plugin install collision-guard@claude-mody --scope user --config windowMinutes=30
```

### Bez terminala: w aplikacji desktopowej

Kliknij **+** obok pola promptu, potem **Plugins** i **Add marketplace**, wpisz `solowsolow/claude-mody`, a następnie dodaj po kolei cztery pluginy przez **Add plugin**.

### Po instalacji

Mody ładują się w każdej **nowej** sesji Claude Code, w każdym folderze. Sesje otwarte w czasie instalacji dostaną je dopiero po ponownym uruchomieniu.

Aktualizacja do najnowszej wersji:

```bash
claude plugin marketplace update claude-mody
```

Potem dla każdego moda osobno, np.:

```bash
claude plugin update usage-bar@claude-mody
```

Odinstalowanie jednego moda, np.:

```bash
claude plugin uninstall radar-sesji@claude-mody
```

## usage-bar

Pasek nad polem promptu:

```
● cache warm 57m  |  ctx 385k · compact in 582k  |  5h 44% · resets 00:49  |  week 2%     →←
```

- **cache warm Nm**: minuty do wygaśnięcia cache promptu głównej rozmowy, liczone od ostatniej tury. Dopóki cache jest „ciepły”, kolejne wiadomości są szybkie i tanie, bo dotychczasowa rozmowa jest odczytywana z pamięci podręcznej. Po wygaśnięciu („cache cold”) pierwsza wiadomość przelicza całą rozmowę od nowa. W ostatnich minutach kropka robi się bursztynowa, po wygaśnięciu szara.
- **ctx**: tokeny w oknie kontekstu, a **compact in** pokazuje, ile zostało do automatycznego kompaktowania.
- **5h / week**: okna limitów subskrypcji. Kolor zmienia się przy 50% i 80%, a **resets** odlicza czas do resetu okna 5h.
- **→←**: kompaktuje rozmowę (to samo co `/compact`).
- `/usage-bar` chowa i pokazuje pasek.

Opcja `cacheTtl` (60 albo 5 minut) ustawia czas życia cache, bo Claude Code go modom nie podaje. Przy subskrypcji Pro/Max zostaw 60.

## context-bar

Karta nad polem promptu z podziałem kontekstu, jak w `/context`, tylko stale na widoku:

- nagłówek z zajętością okna, progiem kompaktowania i procentem (zielony, bursztynowy od 50%, czerwony od 80%);
- pasek kategorii w proporcji do okna z bursztynowym znacznikiem progu auto-kompaktowania;
- legenda: prompt systemowy, narzędzia, narzędzia MCP, instrukcje MCP, agenci, pliki pamięci, skille, wiadomości i wolne miejsce.

Trójkąt **▼** obok tytułu zwija legendę, a wybór zostaje na kolejne sesje. To samo robi `/context-bar legenda`. Samo `/context-bar` chowa całą kartę.

## radar-sesji

Mówi, które **inne** sesje Claude na tym komputerze czekają na Ciebie:

- **czeka na zgodę**: prośba o uprawnienie (np. „zgoda na Bash”);
- **pyta**: pytanie z wyborem, plan do akceptacji albo formularz serwera MCP;
- **skończyła turę**: czeka na Twoją następną wiadomość.

Linia nad promptem pojawia się tylko wtedy, gdy któraś sesja czeka: bursztynowa przy zgodzie albo pytaniu („1 sesja czeka: strona-firmy deploy · zgoda na Bash · 4 min”), szara, gdy sesje tylko skończyły turę w ciągu ostatniej godziny. Sesję nazywa początek jej pierwszego promptu. Małe **×** na końcu linii chowa widoczne sesje, dopóki nie zmienią stanu. `/sesje` otwiera panel z pełną listą.

Radar widzi tylko sesje na tym samym komputerze, w których też jest zainstalowany. Nie przełącza do wskazanej sesji, bo mody tego nie potrafią.

## collision-guard

Gdy Claude chce zmienić plik (`Edit`, `Write`, `NotebookEdit`), który w ostatnich 30 minutach zmieniała **inna aktywna** sesja Claude na tym komputerze, mod pyta:

- **Edytuj mimo to**: zmiana przechodzi, a zgoda obowiązuje dla tego pliku do końca sesji;
- **Przenieś do worktree**: zmiana jest wstrzymana, a Claude ma przejść do osobnego git worktree i powtórzyć ją tam;
- **Anuluj**: zmiana nie przechodzi.

`/kolizje` pokazuje pliki edytowane przez inne aktywne sesje. Opcja `windowMinutes` (15, 30 albo 60) ustawia okno kolizji. Mod widzi tylko zmiany wprowadzane przez Claude na tym komputerze, a nie te z edytora czy z innej maszyny.

## Co mody zapisują na dysku

Nic nie jest wysyłane poza Twój komputer. radar-sesji i collision-guard zapisują drobne pliki stanu (ok. 300 bajtów na sesję) w `~/.claude/radar-sesji/` i `~/.claude/collision-guard/`, żeby sesje mogły się nawzajem widzieć. usage-bar i context-bar zapamiętują w magazynie pluginu tylko swoje ustawienia, np. czas ostatniej tury i zwinięcie legendy.

## Dla zaglądających w kod

Każdy mod ma testy (`claude plugin test <folder moda>`) i przechodzi `claude plugin validate <folder moda>`.

## Licencja

MIT, pełny tekst w pliku [LICENSE](LICENSE). Mody wolno używać, kopiować, przerabiać i udostępniać dalej, także w zmienionej wersji, pod warunkiem zachowania informacji o licencji.
