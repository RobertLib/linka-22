# Městský provoz a chodci

Vrstva `src/urban-life.js` řídí pohyb vozidel, pěších, nástup a společné signální programy. Není to přehrávání skutečného aktuálního provozu ani rekonstrukce řídicích programů konkrétních pražských křižovatek.

## Geografická data

Přechody jsou skutečné mapované uzly a geometrie OpenStreetMap. `public/data/crossings.json` obsahuje **495 uzlů přechodů do 29 metrů od trasy**, z nichž **183 je označeno jako světelně řízených**; připojeno je **440 samostatných geometrií chodníkových úseků přechodů**. Body byly vybrány z původních XML výřezů OSM map API, které byly staženy 13. října 2026 pro tento projekt. Souřadnice jsou zachovány s přesností na sedm desetinných míst, zdrojové identifikátory jsou uloženy u každého objektu. Data © OpenStreetMap contributors, [ODbL 1.0](https://www.openstreetmap.org/copyright).

Význam atributů byl ověřen podle [OSM — highway=crossing](https://wiki.openstreetmap.org/wiki/Tag:highway%3Dcrossing) a [OSM — highway=traffic_signals](https://wiki.openstreetmap.org/wiki/Tag:highway%3Dtraffic_signals). Blízké uzly jsou seskupeny v podélné vzdálenosti 8 m, takže několik uzlů v jízdních pruzích představuje jeden přechodový děj. Výsledek obsahuje **321 skupin přechodů**. Bílá zebra je sestavena z jednotlivých obdélníkových pruhů podle skutečných OSM geometrií; úseky označené jako neznačené nemají vymyšlené pruhy. Není-li připojen chodníkový úsek, je rozsah zebry odvozen z šířky silnice v herní scéně a originální uzel určuje její polohu.

**77 signálních konfigurací** vychází z mapovaných semaforů a světelných přechodů poblíž trasy. Původní fikční semafory „za každou zastávkou“ byly nahrazeny touto vrstvou. **28 křižných dopravních cest** vychází z OSM silnic, které opravdu protínají osu linky. Při sestavování cest se spojují skutečně společné koncové uzly cest a pokračování s odpovídajícím směrem; silnice nejsou protahovány přes budovy.

## Vozidla a fyzika provozu

Na vysokou kvalitu je v okolí hráče připraveno 36 podélně jedoucích vozidel, až 8 vozidel na bočních silnicích a až 32 zaparkovaných vozidel; dvě podélná vozidla jsou protijedoucí dvouvozové soupravy T3. Střední a nízká kvalita snižují počet objektů. Vzdálená vozidla se dávkově vykreslují pomocí instancí skutečné sloučené geometrie Blender modelů, blízká používají kompletní modely s oddělenými světly a koly. Vzdálení pěší přecházejí na šest animovaných instancovaných částí těla. Tato úroveň detailu snižuje počet vykreslovacích volání; chodci zůstávají viditelní do 155–220 m a vozidla do 260–350 m podle nastavení kvality. Dostupné Blender modely kombi, hatchbacku a dodávky mají různé laky, kola, brzdová světla a světla. Kola se otáčejí podle skutečné ujeté vzdálenosti. Brzdová světla reagují na zpomalování a zastavení.

Podélný provoz používá model následování s odstupem závislým na rychlosti a relativní rychlosti, omezením zrychlení, brzdění a rychlosti změny zrychlení. Stav se integruje po nejvýše 1/30 s. Čelo auta zastavuje před návěstním bodem, ne jeho střed; pevná kontrola brzdné polohy brání průjezdu červené a zachovává prostor mezi nárazníky. Vůz, který již vjel do křižovatky, pokračuje i po změně fáze. Auta na stejné koleji čekají před zadním koncem celé hráčovy soupravy. Auta na straně nástupu čekají při otevřených dveřích.

Boční provoz používá délku skutečné mapové polylinie; vozidlo mění směr podle jejího průběhu. Čeká na boční zelenou, bezpečný odstup od tramvaje a volný přechod. Všechny pohyby používají metry a sekundy. Dopravní hustota, typy a barvy vozidel a jejich jízdní styl jsou herní generování, nikoli živá data z Prahy.

Vozidla a chodci se recyklují až mimo svou viditelnou oblast. Na konečné hranici boční mapové cesty automobil zajede ke kraji a zůstane přítomen, dokud tato silnice neopustí okolí hráče; zmizení uprostřed křižovatky se nepoužívá. Zaparkovaná vozidla vynechávají přechody, zastávky, most a úzké historické ulice a mají trvalý deterministický identifikátor svého místa.

## Světelné signály

Bílé tramvajové čočky, tříbarevná světla podélné a boční automobilové dopravy a červené/zelené postavičky pěších mají **stejný čas** jako kontrola návěstidel ve fyzice hráče. Každá simulovaná perioda obsahuje podélné volno, žlutou, ochrannou dobu, boční volno a samostatný pěší interval. Pěší zelená se nepřekrývá se zelenou vozidel. Podélné semafory zobrazují také červenou se žlutou před rozjezdem. Tramvajové návěstidlo zobrazuje tři vodorovná bílá světla pro stůj a prostřední horní se spodním pro volno přímo.

Časy period a odsazení jsou vědomou herní aproximací. Nejde o ověřené řídicí programy, tramvajovou preferenci nebo přesné skutečné postavení všech sloupů.

## Chodci a nástup

Vrstva připravuje až 88 chodců v blízkém okolí, s menšími počty na úsporné nastavení. Pěší mají čtyři nezávislé pivoty rukou a nohou; krok mění jejich úhel podle rychlosti chůze, takže postavy pouze nekloužou ani neposkakují celé. Oblečení, výška a odstín pleti se liší. Chůze sleduje chodník a ověřuje následující krok proti prostorovému indexu skutečných půdorysů budov, včetně vnitřních dvorů.

Chodci čekají na okraji přechodu na svou zelenou. Před vstupem také kontrolují, zda se nepřibližuje tramvaj, která nestačila zastavit. Na neřízeném přechodu nevstupují před jedoucí tramvaj; tento princip odpovídá [kampani DPP „Neskákej mi pod kola!“](https://www.dpp.cz/spolecnost/pro-media/tiskove-zpravy/detail/278_288-na-riziko-stretu-tramvaje-s-chodcem-upozorni-lidske-siluety-kampan-neskakej-mi-pod-kola-pokracuje). Automobily čekají před obsazeným přechodem a také před neřízeným přechodem, u kterého někdo čeká. Zvonek hráče prodlouží vyčkání chodce poblíž tramvaje.

Zastávkové skupiny stojí na pravé straně nástupiště. Při otevřených dveřích stojící tramvaje vyberou nejbližší ze šesti dveří soupravy, dojdou k nim skutečným pohybem a zmizí uvnitř až po dosažení dveří. Zmeškaní cestující zůstávají na nástupišti; není použito plošné skrytí podle indexu projeté zastávky. Počet cestujících ve fyzice je stále samostatný herní model.

## Kolize a ověření

Kolize s hráčem se hlásí pouze při skutečném průniku orientovaných půdorysů dvou konkrétních tramvajových vozů a vozidla nebo chodce. Používá se test oddělujících os s kontrolou výšky. V zastaveném čase a menu se kolize nehlásí. Kontakt předává fyzice hmotnost a rychlost druhého účastníka; široká „zóna před tramvají“ není kolizí.

`node scripts/test-urban-life.mjs` ověřuje vzájemně výlučné signální fáze, úplné zastavení na červené, odstupy tří aut ve frontě, rozjezd na zelenou, odstup od zadního vozu soupravy, přednost obsazenému přechodu, orientované kolize, polohu přechodů a křižných cest v mapě, nevstupování pěších do půdorysů budov a konečné numerické hodnoty všech transformací a geometrií scény. Test používá skutečné geografické soubory projektu.

## Průjezd Oettingenským palácem a kolejová splítka

Historický text [DP kontakt 1/2004 — Když někde vedla jen jedna kolej](https://www.metroweb.cz/dp-kontakt/2004/01_2004.pdf) popisuje tramvajový průjezd domem u vyústění Letenské ulice na Malostranské náměstí a zdejší kolejovou splítku. Nejde o běžný průjezd dvou současně míjejících se tramvají. Ve scéně proto protisměrná kolej v tomto úseku používá `Route.opposingOffset(s)` a přibližuje se k ose hráčovy koleje; plynulý náběh zajišťuje spojitost kolejí, trolejí a pohybu vozidel.

`src/passage.js` rozděluje skutečné stěnové hrany paláce (`relation/4681559`) podle průniku s koridorem trasy. Spodní průjezd má **odhadovanou šířku 4 m a světlou výšku 6,2 m**, s bočními stěnami a stropem; tyto rozměry nejsou geodetické zaměření. Neporušené části skutečného půdorysu zůstávají plnými stěnami. Prostorový index AI rozlišuje tento otevřený koridor od zbytku paláce.

Protijedoucí vozidla před úzkým úsekem vyčkávají, když se hráč blíží nebo souprava prostorem projíždí. Virtuální zastavovací bod leží na kilometru 8 403 m; protisměr se uvolní až po projetí zadního vozu hráče. Inicializace a obnova vzdálených vozidel nesmí založit nové protijedoucí vozidlo uvnitř splítky. Toto řízení je herní preference hráče, nikoli ověřený program skutečného zabezpečení DPP.

Auta na úzké Malé Straně sdílejí jízdní prostor s tramvajemi. Přechod z krajních automobilových pruhů začíná před zúžením a probíhá plynule. Každý vůz protijedoucí soupravy sleduje svou vlastní polohu, výšku a tečnu koleje, včetně vzdáleného instancovaného modelu a kolizního půdorysu. Detailní řidičská kabina se u NPC nevykresluje.

`node scripts/test-passage.mjs` ověřuje otvory ve skutečném půdorysu paláce, konečné souřadnice a UV, šestimetrovou světlou výšku a pomocí průsečíků paprsků s trojúhelníky průjezd obou os splítky i okrajů vozidla bez stěny pod výškou 5,8 m. Test provozu navíc ověřuje vyčkání protijedoucí soupravy a její rozjezd po uvolnění prostoru.

## Regrese odjezdu po nástupu

Kolizní půdorys předního hráčova vozu používá přesně stejné natočení jako vykreslený model. U předního vozu je to směr mezi předním a zadním bodem karoserie; krátká tečna v jejím středu se v utaženém oblouku lišila a mohla vyvolat falešný kontakt. Na místech, kde interpolovaná trať neposkytuje současnému průjezdu dvou dlouhých obrysů dostatečnou vůli, AI vyčkává před obloukem na uvolnění celé soupravy. Je to ochrana herního provozu při aproximované geometrii, nikoli tvrzení o skutečném provozním omezení DPP. Pěší při odhadu doby příjezdu také berou v úvahu probíhající rozjezd tramvaje.

Test provozu reprodukuje 110 sekund nástupu na Malostranském náměstí a poté 30 sekund jízdy s výkonem 40 % pomocí skutečné fyziky dvouvozové soupravy. V ověřeném běhu tramvaj ujela přes 120 m bez kolize, poškození a nouzové brzdy. Další kontrola úmyslně umístí automobil přímo do obrysu tramvaje a ověří, že skutečná kolize zůstává aktivní. `urban.stats.lastCollision` a `recentCollisions` obsahují účastníky, polohy, rychlosti před kontaktem, konkrétní obrysy a čas; nová služba tuto diagnostiku vymaže.
