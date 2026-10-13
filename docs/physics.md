# Fyzika tramvaje a její ověření

`src/simulation.js` odděluje simulaci od Three.js. Integruje síly v newtonech,
hmotnost v kilogramech, rychlost v m/s a čas v sekundách po krocích nejvýše
1/60 s. `s` je poloha čela tramvaje po trase. `getGrade(s)` vrací poměr
převýšení a vodorovné délky; `0.04` je stoupání 4 %. `getCurveRadius(s)` vrací
poloměr oblouku v metrech se znaménkem směru zatáčky. `Infinity` znamená přímou
trať. Zastávky a stop čáry používají stejnou délkovou referenci.

## Co je doloženo primárními zdroji

T3R.P má prázdnou hmotnost 17 300 kg, čtyři trakční motory po 40 kW, délku přes
spřáhla 15,104 m, šířku 2,5 m a maximální provozní rychlost 65 km/h. Kapacita
je 22 sedících a 69 stojících. Souprava dvou vozů proto má 34,6 t bez
cestujících a 320 kW instalovaného výkonu. Zdroj: [DPP – Tatra T3R.P](https://www.dpp.cz/vozovy-park/tramvaje/tatra-t3r-p), ověřeno 13. října 2026.

Použití pulzní výzbroje TV Progress, možnost vracení brzdné energie do vedení,
protiskluzová/protismyková ochrana a elektrické pískovače jsou popsány přímo
Dopravním podnikem v [DP Kontakt 11/2022, článek o modernizacích T3](https://www.dpp.cz/data/leaflets/documents/2022-11-28-08-06-53_DP-kontaktlistopad-2022-web.pdf).
Model proto odděluje elektrodynamickou brzdu, mechanické dobrzdění, adhezi
kolo–kolejnice a pískování. Nejde o přepis neveřejného regulátoru TV Progress.

Volitelný profil 15T používá údaje pražského provozovatele: 43,8 t, 31,4 m,
šířku 2,46 m, provozní maximum 60 km/h, kapacitu 199 a výkon 16 × 46,6 kW,
tedy 745,6 kW. Zdroj: [DPP – Škoda 15T](https://www.dpp.cz/vozovy-park/tramvaje/skoda-15t).
[Obecná stránka výrobce pro pražskou ForCity Alfa](https://www.skodagroup.com/reference/tramcar-forcity-alfa-prague)
uvádí 720 kW; v herním profilu je upřednostněn aktuálně zveřejněný údaj DPP.
Jízdní síly profilu 15T se škálují podle hmotnosti, jeho detailní motorové
mapy nejsou samostatně změřeny. Výchozí hra modeluje soupravu T3R.P.

## Pohyb podle sil

Základní rovnice je `a = (Ftrakce − Fbrzdy − Fodpor − Fsklon) / mefektivní`.
Efektivní hmotnost zahrnuje 7% přírůstek na rotační setrvačnost kol a pohonu;
cestující přidává předpokládaných 75 kg. Tyto dvě hodnoty jsou modelové
předpoklady. Skutečná síla ve svahu je `m × g × grade / sqrt(1 + grade²)`.

Při rozjezdu je tah omezen momentem: nejvýše 26 kN na vůz. Při vyšší rychlosti
jej omezuje výkon `F = P / v` a vždy také dostupná adheze `F ≤ μ × m × g`.
Přidání cestujících proto ovlivňuje zrychlení i energii. Síla narůstá plynule
s předpokládaným rázem 0,7 m/s³; při přechodu do brzdění 0,9 m/s³. U nouzové
brzdy je náběh rychlejší, 4,5 m/s³. Omezuje se změna síly motorů a brzd;
gravitace se nepřevádí na uměle pomalou změnu zrychlení.

Rychlost 65 km/h vypíná trakci. Pohyb se na této rychlosti neořízne: ve spádu
může tramvaj zrychlit nad provozní maximum a řidič musí brzdit. Traťové
rychlosti, zastávky ani červené návěsti samy nesnižují rychlost hráče.

Jízdní odpory mají tvar Davisovy aproximace: valivá složka úměrná hmotnosti,
lineární složka úměrná rychlosti a aerodynamická složka úměrná `v²`. V oblouku
přibývá odpor vedení kol po kolejnicích podle `m × g × 0,45 / |R|`. Použité
součinitele jsou otevřeně uvedeny v exportu `PHYSICS`; nejsou vydávány za
měření konkrétního pražského vozu.

## Brzdy, déšť a písek

Plné provozní brzdění požaduje 32 kN na vůz. Elektrodynamická brzda je omezena
silou a krátkodobým výkonem nejvýše dvojnásobku trakčního výkonu. Pod 1,8 m/s
její účinek plynule klesá s rychlostí; současně se přidává mechanická brzda.
V nulové rychlosti elektrodynamická brzda nedrží, drží mechanická. Tento
přechod brání nereálnému elektrickému brzdění v úplném zastavení.

Nouzové brzdění požaduje 40 kN na vůz na kolech a přidává 20 kN na vůz
kolejové brzdy; v dešti je kolejová složka předpokládaně o 10 % nižší.
Kolejová brzda má modelovaný náběh 0,2 s, takže v jediném integračním kroku
nepřidá skokem celou brzdnou sílu.
Kolejová brzda se neomezuje součinitelem adheze kol. Brzdění na kolech se
omezuje stejně jako trakce dostupnou adhezí; při smyku se účinek regulátoru
snižuje o další 4 %. Všechny uvedené brzdové síly, náběhy a prahy jsou
kalibrované herní předpoklady, nikoli zveřejněná brzdová zkouška T3R.P.

Výchozí adheze je 0,23 na suchu a 0,085 při dešti. Pískování ji s náběhem
0,5 s zvedá na 0,26 / 0,15. Po uvolnění pískovače účinek během přibližně
dvou sekund odeznívá. `setSanding(true/false)` ovládá hráč podržením G.
`wheelSlip` je poměr požadované síly přesahující dostupnou adhezi v rozsahu
0–1, nikoli přesná úhlová rychlost jednotlivé nápravy.

Déšť tedy nemění hmotnost ani výkon motorů. Sníží sílu, kterou kola dokážou
přenést, a při vysokém požadavku vznikne skluz nebo smyk. Na strmém pražském
spádu může bez písku zbýt velmi malá čistá decelerace. Řidič musí snížit
rychlost předem a použít písek; nouzová kolejová brzda je samostatná rezerva.

Nová a obnovená služba začíná zabrzděná. Výslovné zvolení řadiče, včetně
výběhu 0, uvolní počáteční parkovací brzdu. Výběh pak na klesající koleji
nedrží ani stojící tramvaj. Zámek dveří a ukončená služba používají skutečný
požadavek mechanické brzdy. Pohyb dozadu, samostatná dynamika jednotlivých
kol, vykolejení a deformace skříně se zatím nemodelují.

`getBrakingDistance({ emergency, reactionTime })` integruje stejnou brzdovou
charakteristiku, náběh síly, zatížení, adhezi a sklon podél předpokládané
brzdné dráhy. Základní doporučení přidává 0,8 s reakce řidiče. Nouzová
projekce reakční čas nepřidává. Během reakce působí dosavadní síla řadiče a
gravitace, takže se ve spádu může zvýšit i rychlost při zahájení brzdění.
Pokud model nedokáže do 180 s zastavit,
metoda vrátí `Infinity`. Pro HUD je údaj `brakingDistance` omezen na 1000 m
a doprovázen příznakem `brakingUnsafe`, takže aplikace může zobrazit varování.
Projekce předpokládá aktuální adhezi, ne budoucí aktivaci písku.

## Energie, proudy a pohyb skříně

Mechanická práce motorů je `Ftrakce × v`. Odběr z vedení započítává
předpokládanou účinnost 88 %, měděné ztráty rostoucí s druhou mocninou síly
a pomocné spotřebiče 2,5 kW na vůz. `powerKW` je mechanický výkon motorů,
`tractionCurrentA` odhad trakčního proudu odebíraného z 600V vedení a
`brakeCurrentA` odhad vyrobeného elektrodynamického proudu. Nejde o proud
každého jednotlivého motoru. `lineCurrentA` zahrnuje pomocné spotřebiče a
energii skutečně vracenou do vedení; při rekuperaci může být záporný.

Předpokládaná účinnost výroby při brzdění je 72 %. `regenerationReceptivity`
určuje, jakou část vyrobené energie vedení přijme (výchozích 60 %).
Nepřijatá část přejde do odporníku; brzdná síla se tím nesníží. Počitadla
`consumptionKWh`, `regeneratedKWh`, `netEnergyKWh` a `resistorHeatKWh` se
počítají z práce a času. Uložení uchovává spotřebu, rekuperaci a energii
odporníku, aby obnovení jízdy nevymazalo bilanci.

Oblouk vytváří příčné zrychlení `v² / R`, které vrací `lateralAccel`.
`chassisRoll` je v radiánech a používá tlumené odpružení, `chassisPitch`
reaguje na podélné zrychlení. `rideShake` představuje drobný zdvih v metrech
od kolejových spojů a drobných nerovností; v klidu je nulový. Vizuální
součinitele odpružení a nerovností jsou aproximace. Nezvyšují přímo tah nebo
brzdnou sílu a nemohou ovlivnit podélnou energetickou bilanci.

## Střety a obsluha zastávek

`reportCollision()` přijímá původní číselnou závažnost nebo objekt
`{ severity, otherMass, otherSpeed, restitution, impactFraction }`.
Impuls se počítá z redukované hmotnosti, relativní rychlosti a předpokládané
restituce 0,05. Střet s 1,5t autem proto nevymaže většinu hybnosti soupravy.
Po střetu se aktivuje nouzová brzda. Ztracená energie zvyšuje trvalý údaj
`damage`; velké poškození omezuje dostupný výkon. Je to jednorozměrná
aproximace kontaktu, ne deformovatelný fyzikální model nehody.

Obsluha zastávky vyžaduje stání v toleranci 18 m od označníku, správnou
stranu dveří, dokončené otevření a osm sekund souvislého nástupu. Obsloužení
se započte až po zavření a zajištění dveří. Návěstidla používají
`getSignalAspect(signal, time)`; městský provoz čte stejný čas. Cykly
křižovatek jsou herní simulace. Délky otevírání a zavírání dveří a pobyty
nepředstavují skutečný služební předpis DPP.

`getSaveState()` uchovává polohu, další zastávku, skóre, cestující, čas,
přestupky, energetickou bilanci, poškození i již dokončený nástup.
Obnovení začíná se zavřenými dveřmi, nulovou rychlostí a parkovací brzdou.
Dokončená obsluha se započte právě jednou; cestující se nevymění podruhé.

## Ověření

`node scripts/test-simulation.mjs` má 25 testů. Ověřuje mimo jiné výkonový
limit, rovnici sil, kinetickou energii proti vykonané práci, soulad
rekuperované energie s dostupnou kinetickou energií, stejnou brzdnou sílu
při nepřijímajícím vedení, projekci brzdné dráhy proti skutečnému zastavení,
brzdové přechody, kolejovou brzdu, zhoršení adheze, zlepšení po pískování,
rozjezd výběhem z kopce, tlumený náklon v oblouku, impuls střetu a uložení.

`node scripts/test-journey.mjs` prochází všech 44 zastávek Bílá Hora →
Nádraží Hostivař s třídou `Route`, skutečnou geometrií trasy, výškovým
profilem, oblouky a simulovanými cykly návěstidel. Testovací řidič existuje
pouze v testu a v dešti výslovně obsluhuje pískovač. Poslední ověření:
62,9 min na suchu, 71,5 min v dešti, maximum 48,5 km/h, spád až 7,56 %,
všech 44 zastávek bez projeté návěsti Stůj, překročení rychlosti nebo
nebezpečného otevření dveří. Největší odchylka zastavení byla 0,84 / 2,16 m.
Jde o výsledek simulace, nikoli skutečnou jízdní dobu linky 22.
