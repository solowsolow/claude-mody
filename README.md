# claude-mody

Pięć modów do Claude Code po polsku. Każdy to plugin z modułem hooków, który dokłada coś do interfejsu albo zachowania Claude Code:

| mod | co robi |
|---|---|
| **usage-bar** | pasek nad polem promptu: stan cache promptu, zapełnienie kontekstu, limity 5h i tygodniowy, przycisk kompaktowania |
| **context-bar** | karta nad promptem z podziałem kontekstu na kategorie, progiem auto-kompaktowania i tokenami zużytymi w sesji |
| **agents-panel** | panel obok czatu z agentami projektu: model, effort, kontekst i zużyte tokeny każdego agenta, bieżące narzędzie i przycisk uruchomienia |
| **radar-sesji** | linia nad promptem i panel `/sesje`: które inne sesje Claude na tym komputerze czekają na Ciebie |
| **collision-guard** | ostrzega, zanim Claude zmieni plik, który przed chwilą zmieniała inna sesja Claude |

Wymagany jest Claude Code 2.1.309 lub nowszy (mody testowano na 2.1.309–2.1.312, na macOS). agents-panel i licznik tokenów sesji w context-bar sprawdzano na 2.1.330. Na starszej wersji brakujące dane po prostu się nie pojawią.

## Instalacja w Claude Code

Wklej poniższy tekst jako wiadomość w dowolnej sesji Claude Code, w terminalu albo w aplikacji desktopowej:

```text
Zainstaluj mi mody do Claude Code z publicznego repozytorium solowsolow/claude-mody.

1. Dodaj marketplace: claude plugin marketplace add solowsolow/claude-mody
2. Zainstaluj w zakresie user pięć modów, każdy osobnym poleceniem:
   claude plugin install usage-bar@claude-mody --scope user --config cacheTtl=60
   claude plugin install context-bar@claude-mody --scope user
   claude plugin install radar-sesji@claude-mody --scope user
   claude plugin install collision-guard@claude-mody --scope user --config windowMinutes=30
   claude plugin install agents-panel@claude-mody --scope user
3. Sprawdź w ~/.claude/plugins/installed_plugins.json, że wszystkie pięć jest zainstalowanych, i podaj mi ich wersje.

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

```bash
claude plugin install agents-panel@claude-mody --scope user
```

### Bez terminala: w aplikacji desktopowej

Kliknij **+** obok pola promptu, potem **Plugins** i **Add marketplace**, wpisz `solowsolow/claude-mody`, a następnie dodaj po kolei pięć pluginów przez **Add plugin**.

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
- **→←**: kompaktuje rozmowę (to samo co `/compact`). Po każdym kompaktowaniu, także automatycznym, toast mówi, ile ubyło z okna i ile kosztowało podsumowanie, np. „Skompaktowano 606k → 74k · koszt: 7k wyjścia, 1k wejścia, 605k z cache”. Gdy podsumowanie było policzone zawczasu, toast mówi „bez danych o koszcie”.
- `/usage-bar` chowa i pokazuje pasek.

Opcja `cacheTtl` (60 albo 5 minut) ustawia czas życia cache, bo Claude Code go modom nie podaje. Przy subskrypcji Pro/Max zostaw 60.

## context-bar

Karta nad polem promptu z podziałem kontekstu, jak w `/context`, tylko stale na widoku:

- nagłówek z zajętością okna, progiem kompaktowania i procentem (zielony, bursztynowy od 50%, czerwony od 80%);
- obok tytułu liczba tokenów zużytych od startu sesji („zużyto w sesji 12.4M”): wszystkie zapytania rozmowy i jej subagentów oraz podsumowania przy kompaktowaniu, razem z odczytami cache. Mod liczy ją sam, bo Claude Code takiej sumy nie podaje. Wznowiona sesja liczy dalej, a `/clear` zaczyna od zera;
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

## agents-panel

Panel obok czatu, otwierany komendą `/agents-panel`, z agentami zdefiniowanymi w `.claude/agents` projektu i w `~/.claude/agents`:

- **wiersz agenta**: nazwa, model i effort (np. „haiku 4.5 · low”), opis i przycisk **▶ uruchom** (skróty 1–9). Przed pierwszym uruchomieniem model i effort pochodzą z pliku agenta, potem z jego ostatniego zapytania;
- **podczas pracy**: spinner, czas („działa · 12s”) i bieżące narzędzie zamiast opisu (np. „⏵ Read · app.ts”), a po zakończeniu „✓” albo „✕”. Kliknięcie w status otwiera transkrypt agenta;
- **pomiar**: „kontekst 42k z 200k 21% · zużyto 34k” i cienki pasek zapełnienia okna, który płynnie dorasta przy każdym zapytaniu. Kolory są takie jak w context-bar: bursztynowy od 50%, czerwony od 80%. „Zużyto” to wszystkie tokeny zapytań agenta, razem z odczytami cache;
- **INNE AGENTY**: subagenci, których Claude uruchamia z typów bez pliku w `.claude/agents` (np. `Explore`, `general-purpose`), z tymi samymi danymi. Zakończeni zostają widoczni przez 10 minut.

Przycisk **▶ uruchom** startuje agenta z ogólnym zadaniem („wykonaj swoje zadanie na bieżącym stanie projektu i zwróć raport”), więc zużywa tokeny jak każdy subagent. Panel czyta pliki agentów i pokazuje model oraz effort z ich frontmattera bez znaków sterujących, przycięte do 24 znaków.

## Co mody zapisują na dysku

Nic nie jest wysyłane poza Twój komputer. radar-sesji i collision-guard zapisują drobne pliki stanu (ok. 300 bajtów na sesję) w `~/.claude/radar-sesji/` i `~/.claude/collision-guard/`, żeby sesje mogły się nawzajem widzieć. usage-bar i context-bar zapamiętują w magazynie pluginu swoje ustawienia, np. czas ostatniej tury i zwinięcie legendy. context-bar trzyma tam też dla każdej sesji jedną liczbę zużytych tokenów i usuwa liczniki sesji starszych niż 30 dni. agents-panel nie zapisuje niczego na dysku: listę uruchomień trzyma tylko na czas sesji.

## Dla zaglądających w kod

Każdy mod ma testy (`claude plugin test <folder moda>`) i przechodzi `claude plugin validate <folder moda>`.

## Licencja

MIT, pełny tekst w pliku [LICENSE](LICENSE). Mody wolno używać, kopiować, przerabiać i udostępniać dalej, także w zmienionej wersji, pod warunkiem zachowania informacji o licencji.
