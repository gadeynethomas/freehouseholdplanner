# PRD: freehouseholdplanner

Nov 11, 2026

## Doel

freehouseholdplanner helpt ons huishouden om alledaagse huistaken en grotere projecten in huis voorspelbaar te plannen, op te volgen en af te werken.

- **Huistaken:** poetsen, was, planten, onderhoud; eenmalig of terugkerend.
- **Projecten:** een badkamer renoveren, een tuin aanleggen, een zolder isoleren.

De app brengt wat professionele planningstools (zoals Microsoft Planner) kunnen naar het huishouden: taken, fasen, budgetten, offertes en planning. Toch moet ze bruikbaar blijven voor wie nooit met zo'n tool werkte. De meerwaarde is **voorspelbaarheid**: op elk moment weten wat er nog moet gebeuren, wie het doet, wanneer, en of het binnen het budget blijft.

Dit document zegt **wat** de app doet en **waarom**. Hoe hij gebouwd wordt, staat in het [technisch document](TECHNICAL.md) (Engels).

## Gebruikers en uitgangspunten

Eerst enkel voor eigen gebruik; later misschien open source, zodat anderen hem zelf kunnen draaien.

| Wie | Wil | Heeft geen zin in |
| --- | --- | --- |
| **De planner** | Overzicht over projecten, budget en planning; vergelijken en beslissen | Dubbel werk, losse Excel-lijstjes |
| **De huisgenoot** | Zien wat vandaag of deze week verwacht wordt, en het afvinken | Ingewikkelde schermen, verplichte velden |
| **De externe** (vakman, leverancier) | Geen gebruiker van de app; komt erin voor als contact, uitvoerder en opsteller van een offerte |  |

Vijf uitgangspunten:

1. **Eenvoudig aan de oppervlakte, professioneel eronder.** Een taak aanmaken vraagt enkel een titel. Budget, fase, datums, uitvoerder en offertes verschijnen pas als je ze nodig hebt.
2. **Gewone taal.** "Gaan we over budget?" in plaats van vakjargon.
3. **Gsm eerst voor huistaken, groot scherm eerst voor projecten.** Afvinken gebeurt onderweg; plannen en vergelijken aan een bureau. Beide werken op elk scherm.
4. **Onze gegevens blijven van ons.** Elk apparaat in het huishouden heeft alle gegevens lokaal en werkt zonder server of internet; apparaten synchroniseren rechtstreeks met elkaar, end-to-end versleuteld. Geen hosting die online moet blijven, geen tracking, geen externe diensten, alles exporteerbaar.
5. **Toegankelijk.** Bruikbaar met toetsenbord en schermlezer, voldoende contrast (doel: WCAG 2.2 niveau AA).

## Begrippen

Deze woorden betekenen in de app en in dit document telkens hetzelfde.

| Begrip | Betekenis |
| --- | --- |
| Huishouden | De groep mensen die de app samen gebruikt; alle gegevens horen bij één huishouden |
| Lid | Een persoon in het huishouden, met een eigen profiel en één of meer gekoppelde apparaten |
| Ruimte | Een deel van het huis (keuken, badkamer, tuin), waaraan taken, projecten, ideeën en toestellen kunnen hangen |
| Apparaat | Een gsm, laptop of pc waarop de app draait, met een volledige kopie van de gegevens van het huishouden (niet te verwarren met een toestel in huis) |
| Koppelen | Een nieuw apparaat aan het huishouden toevoegen door een QR-code te scannen op een apparaat dat al gekoppeld is |
| Synchroniseren | Apparaten wisselen hun wijzigingen uit zodra ze elkaar bereiken, zodat iedereen dezelfde gegevens heeft |
| Altijd-aan-apparaat | Een optioneel apparaat dat altijd aanstaat (thuisserver, Raspberry Pi, oude gsm aan de lader), zodat andere apparaten altijd iemand hebben om mee te synchroniseren |
| Toestel | Iets in huis met een handleiding, garantie of onderhoud (verwarmingsketel, vaatwasser, rookmelder) |
| Huistaak | Een alledaagse taak, eenmalig of terugkerend, niet gebonden aan een project |
| Terugkerende taak | Een huistaak met een schema; na het afvinken plant de app de volgende keer |
| Project | Een afgebakend geheel van werk met een doel, een begin en een einde |
| Fase | Een deel van een project met een eigen periode (bv. "Afbraak", "Ruwbouw", "Afwerking") |
| Projecttaak | Een taak binnen een project, eventueel binnen een fase |
| Afhankelijkheid | Een taak die pas kan beginnen als een andere klaar is ("tegelen na het pleisterwerk") |
| Oorspronkelijk plan | De planning en het budget zoals vastgelegd bij de start, om later mee te vergelijken |
| Uitvoerder | Wie een taak doet: een lid (eigen werk) of een externe |
| Externe | Een vakman, aannemer of leverancier, bijgehouden als contact |
| Projectbudget | Het bedrag dat we voor het hele project willen uitgeven |
| Taakbudget | Het bedrag dat voor één taak voorzien is |
| Reserve | Een deel van het projectbudget dat apart blijft voor onvoorziene kosten |
| Werkelijke kost | Wat een taak echt gekost heeft: de som van haar uitgaven |
| Uitgave | Een aankoop of betaling voor een taak, met bewijs (kasticket, factuur) |
| Prognose | Wat het project naar verwachting in totaal zal kosten (zie Budget) |
| Offerte | Een prijsvoorstel van een externe voor een taak |
| Premie | Een subsidie of fiscaal voordeel dat we voor een project aanvragen |
| Ideeënbord | Een verzameling foto's, links, kleuren en notities als inspiratie voor een project |
| Sjabloon | Een herbruikbaar project of takenpakket om snel mee te starten |

## Functionaliteit

Elke eis heeft een code (H1, P3, B5 …), zodat we er later naar kunnen verwijzen.

### Huistaken

- **H1** Een huistaak aanmaken met enkel een titel; optioneel: omschrijving, categorie, ruimte, uitvoerder, vervaldatum.
- **H2** Terugkerende taken met een schema:
  - op vaste dagen ("elke maandag", "de eerste van de maand");
  - met een vaste tussentijd ("elke 3 dagen");
  - na het afvinken ("2 weken nadat het laatst gedaan is"), voor taken waarbij het moment niet vastligt.
- **H3** Afvinken met één tik; de app onthoudt wie het deed en wanneer. Afvinken ongedaan maken kan.
- **H4** Een taak overslaan of uitstellen zonder dat het schema verloren gaat.
- **H5** Overzicht **Vandaag** en **Deze week**: wat moet er gebeuren, wat is achterstallig, te filteren op "mijn taken".
- **H6** Geschiedenis per taak: wanneer en door wie ze gedaan werd.
- **H7** **Inschatting van werk en tijd:** elke huistaak krijgt een inschatting van hoeveel werk ze is (licht, gewoon, zwaar) en hoelang ze duurt (in minuten). Vandaag en Deze week tonen hoeveel tijd er gepland staat, zodat je niet meer inplant dan haalbaar is. Na het afvinken kun je optioneel de werkelijke tijd invullen; de app toont het verschil, zodat de inschatting met de tijd beter wordt, en geeft een eerlijk beeld van wat je bereikt hebt. Het doel is realistisch plannen, niet vergelijken wie meer deed. Voor eigen werk in projecten: zie PL9. *(was X18)*
- **H8** **Snelle invoer in gewone taal:** "ramen poetsen elke 2 weken op zaterdag" wordt een terugkerende taak, die je nakijkt vóór ze bewaard wordt. De app herkent vaste zinpatronen met gewone, voorspelbare logica; een lokaal AI-model (op het eigen apparaat of het altijd-aan-apparaat, zonder gegevens naar derden) is eventueel iets voor een latere fase. *(was X21; beslist in N1)*
- **H9** **Alles offline:** op elk apparaat taken aanmaken, bewerken en afvinken zonder bereik. Wijzigingen gaan naar de andere apparaten zodra die bereikbaar zijn (K3). *(was X22; N3 vervangen door N4)*

### Projecten

- **P1** Een project aanmaken met enkel een naam; optioneel: omschrijving, doel, ruimte(s), gewenste begin- en einddatum.
- **P2** Status van een project: idee, in voorbereiding, bezig, gepauzeerd, afgerond, geschrapt.
- **P3** Projecttaken oplijsten met een titel; optioneel: omschrijving, fase, uitvoerder (lid of externe), begin- en einddatum, taakbudget.
- **P4** Status van een projecttaak: te doen, gepland, bezig, klaar, geschrapt.
- **P5** Taken ordenen (slepen) en groeperen per fase.
- **P6** Voortgang per project en per fase: hoeveel taken klaar, hoeveel nog open.
- **P7** Een afgerond project blijft raadpleegbaar (archief), met de werkelijke kosten en planning.
- **P8** **Beslissingen bijhouden** per project: wat er beslist werd, wanneer, door wie en waarom, eventueel gekoppeld aan een taak, offerte of idee. *(was X12)*
- **P9** **Materiaallijst** per taak (wat, hoeveel, waar te koop, gekocht of niet), samen te voegen tot een boodschappenlijst per winkel over taken en projecten heen. *(was X16)*

### Planning

- **PL1** Fasen met een naam en een periode; een project kan ook zonder fasen.
- **PL2** Taken met een begin- en einddatum, of enkel een einddatum.
- **PL3** **Tijdlijn** van een project: fasen en taken als balken op een tijdas, met vandaag als lijn.
- **PL4** **Eigen werk en externen** zijn in elk overzicht in één oogopslag te onderscheiden (kleur én symbool) en te filteren: "wat doen wij", "wat doen de vakmensen", "wat doet Jan de loodgieter".
- **PL5** **Agenda** over alle projecten en huistaken heen: wie doet wat wanneer, per week of per maand.
- **PL6** Taken die over hun einddatum zijn en nog niet klaar, vallen op, in het project en op het startscherm.
- **PL7** **Afhankelijkheden:** een taak kan pas beginnen als een andere klaar is. Schuift een taak op, dan stelt de app voor om de taken erna mee te schuiven, en toont ze het gevolg voor de einddatum van het project. *(was X1)*
- **PL8** **Oorspronkelijk plan:** bij de start van een project leg je planning en budget vast; later toont de app het verschil ("3 weken later en € 1.200 duurder dan gepland"). Opnieuw vastleggen kan, met een reden. *(was X3)*
- **PL9** **Geschatte en werkelijke tijd** voor eigen werk (in uren); na afloop toont de app hoe goed de schatting was, per project en over projecten heen. *(was X4)*
- **PL10** **Weergevoelige taken** markeren (buitenschilderwerk, dakwerk); ze vallen op in de tijdlijn en de agenda. *(was X5)*
- **PL11** **Agenda-abonnement:** elk lid kan zijn of haar planning laten verschijnen in de agenda op de gsm (iCal-link, persoonlijk en in te trekken). Zo'n link moet altijd bereikbaar zijn en werkt dus via het altijd-aan-apparaat (K6); zonder dat exporteert de app de planning als .ics-bestand. *(was X19)*

### Budget

- **B1** Een projectbudget instellen (optioneel).
- **B2** Een taakbudget per projecttaak (optioneel).
- **B3** De werkelijke kost van een taak is de som van haar uitgaven (B9), ook al is de taak nog niet klaar (bv. een voorschot of aangekocht materiaal).
- **B4** Overzicht per project:
  - **Budget:** het projectbudget.
  - **Reserve:** het deel voor onvoorziene kosten (B8).
  - **Verdeeld:** de som van de taakbudgetten; wat nog vrij is (budget min reserve min verdeeld), staat er apart bij.
  - **Uitgegeven:** de som van de werkelijke kosten.
  - **Prognose:** wat het project naar verwachting kost (B5).
  - **Verschil:** budget min prognose, met een duidelijke boodschap: "binnen budget" (de reserve is niet aangesproken), "krap" (de prognose eet van de reserve) of "over budget" (de prognose is hoger dan het budget).
- **B5** De prognose telt per taak die niet geschrapt is:
  - een **klare** taak: de werkelijke kost;
  - een **open** taak met een **gekozen offerte**: het offertebedrag, of de werkelijke kost als die al hoger is;
  - een **open** taak zonder gekozen offerte: het taakbudget, of de werkelijke kost als die al hoger is;
  - een open taak zonder bedrag telt als 0 en wordt gemeld ("3 taken hebben nog geen bedrag"), zodat de prognose niet ongemerkt te laag uitvalt.
- **B6** Per taak en per fase: budget, prognose en uitgegeven naast elkaar, zodat zichtbaar is wáár het over budget gaat.
- **B7** Alle bedragen in euro en **altijd inclusief btw**; ook offertes worden inclusief btw ingevoerd en vergeleken.
- **B8** **Reserve voor onvoorziene kosten:** een percentage van het projectbudget (standaard 10 %, aan te passen), apart getoond in het overzicht. *(was X7)*
- **B9** **Uitgaven met bewijs:** per taak uitgaven invoeren (datum, omschrijving, bedrag, winkel of externe), elk met een foto of pdf van het kasticket of de factuur. *(was X8)*
- **B10** **Premies en fiscale voordelen** per project opvolgen: welke premie, voorwaarden, deadline, benodigde bewijsstukken (te koppelen aan uitgaven), status (te onderzoeken, aangevraagd, toegekend, uitbetaald, geweigerd) en het ontvangen bedrag. Een naderende deadline valt op. Het overzicht toont de kost na premies. *(was X10)*

### Offertes

- **O1** Per projecttaak meerdere offertes bijhouden: externe, bedrag, datum, geldig tot, omschrijving en een bijlage (pdf of foto).
- **O2** Status van een offerte: aangevraagd, ontvangen, gekozen, afgewezen, verlopen.
- **O3** **Vergelijken:** de offertes van één taak naast elkaar, met bedrag, verschil met het taakbudget, geldigheid en notities.
- **O4** Per taak hoogstens één gekozen offerte. Kiezen maakt de externe de uitvoerder (als er nog geen is) en laat de prognose het offertebedrag gebruiken.
- **O5** Een offerte die bijna verloopt en nog niet gekozen of afgewezen is, valt op.
- **O6** **Vergelijken op meer dan de prijs:** per offerte wat inbegrepen is en wat niet, uitvoeringstermijn, garantie en een eigen score; die staan mee in de vergelijking. *(was X11)*

### Externen

- **E1** Contacten voor externen: naam, bedrijf, vak, telefoon, e-mail, notities.
- **E2** Per externe zie je de offertes en taken over alle projecten heen.
- **E3** **Alleen-lezen link** naar een deel van een project voor een externe (bv. de planning en de ideeën voor zijn of haar taak). Elke link is een bewuste keuze: hij toont enkel wat je aanduidt (planning, taakomschrijving, ideeën; nooit bedragen of offertes), is standaard 30 dagen geldig en kan altijd ingetrokken worden. Zo'n link moet altijd bereikbaar zijn en werkt dus enkel via het altijd-aan-apparaat (K6); zonder dat deel je een export als pdf. De details werken we uit bij de bouw van deze functie. *(was X20; beslist in N2)*

### Ideeënbord

- **I1** Per project een ideeënbord.
- **I2** Items op het bord: foto (opgeladen), link naar een webpagina, kleur (met een staal), tekstnotitie.
- **I3** Items krijgen een titel, een notitie en labels (bv. "vloer", "verlichting", "favoriet").
- **I4** Het bord als raster van tegels; filteren op label; items herschikken.
- **I5** Een item koppelen aan een projecttaak ("deze tegel voor de taak Vloer leggen").

### Ruimtes en toestellen

- **R1** **Ruimtes** (keuken, badkamer, tuin …) zelf te beheren; huistaken, projecten, ideeën en toestellen kunnen aan een ruimte hangen, en elk overzicht is op ruimte te filteren. *(was X13)*
- **R2** **Toestellen** bijhouden: naam, merk en type, ruimte, aankoopdatum, einde garantie, met handleiding, garantiebewijs en factuur als bijlage. *(was X14)*
- **R3** **Onderhoud** aan een toestel koppelen als terugkerende huistaak (onderhoud verwarmingsketel elk jaar, rookmelders testen elke maand). *(was X14)*
- **R4** Een toestel kan uit een project komen (de nieuwe vaatwasser uit het keukenproject), met de uitgave als factuur. *(was X14)*

### Sjablonen

- **S1** **Projectsjablonen:** een project met fasen en taken (zonder datums en bedragen) bewaren als sjabloon en een nieuw project daaruit starten. *(was X6)*
- **S2** **Takenpakketten:** een groep huistaken ("grote lenteschoonmaak") in één keer inplannen. *(was X6)*
- **S3** Sjablonen exporteren en importeren als bestand, zodat ze te delen zijn (ook via het open-sourceproject). *(was X6)*

### Startscherm

- **D1** Huistaken van vandaag en achterstallige taken, de lopende projecten met voortgang en budgetstatus, en wat deze week gepland staat, eigen werk en externen apart.

### Huishouden en accounts

- **A1** Elk lid heeft een eigen profiel; er is geen account bij een externe dienst en geen wachtwoord op een server. Eerst gebruiken de twee volwassenen van ons huishouden de app.
- **A2** Rollen: **beheerder** (leden, apparaten en instellingen beheren) en **lid** (alles plannen en afvinken).
- **A3** Een beheerder nodigt een lid uit door koppelen (K2) en kan een lid of apparaat ontkoppelen (K8).
- **A4** Eerst één huishouden (het onze). Elk huishouden is een afzonderlijk, versleuteld geheel, zodat een apparaat later bij meerdere huishoudens kan horen (bv. ook dat van de ouders), strikt gescheiden van elkaar.

### Koppelen en synchroniseren

- **K1** **Apps:** de app draait op Android, Windows en Linux, met dezelfde schermen en functies. Het eerste apparaat maakt het huishouden aan; er is geen server of account bij een dienst nodig. Een huishouden met enkel gsm's werkt volledig: geen pc, altijd-aan-apparaat of relay is nodig om iets anders te laten werken (N6).
- **K2** **Koppelen met een QR-code:** een gekoppeld apparaat toont een QR-code, het nieuwe apparaat scant hem en haalt een volledige kopie op. De code is eenmalig en 10 minuten geldig. Zonder camera (pc) typ je een korte koppelcode over.
- **K3** **Synchroniseren:** apparaten wisselen enkel hun wijzigingen uit, automatisch, zodra ze elkaar bereiken op hetzelfde netwerk (thuis). Onderweg werk je offline; alles komt samen zodra apparaten elkaar weer bereiken (N7). Rechtstreeks via internet en een zelf gedraaide relay zijn mogelijke uitbreidingen voor later, nooit een vereiste. Gsm's die in elkaars buurt zijn, synchroniseren ook zonder gemeenschappelijk netwerk (K12).
- **K4** **Versleuteld:** alle uitwisseling is end-to-end versleuteld met een sleutel die enkel de apparaten van het huishouden kennen. Een relay of netwerk ziet nooit inhoud.
- **K5** **Samenvoegen zonder verlies:** wijzigingen die offline op verschillende apparaten gebeurden, voegt de app automatisch samen. Passen twee mensen hetzelfde veld aan, dan wint de laatste wijziging en blijft de andere zichtbaar in de geschiedenis.
- **K6** **Altijd-aan-apparaat (optioneel):** de app draait ook zonder scherm op een thuisserver, Raspberry Pi of oude gsm aan de lader. Het is een gewoon apparaat van het huishouden zonder extra rechten, maar zorgt dat wijzigingen altijd doorkomen, maakt dagelijks een back-up (G3) en is nodig voor het agenda-abonnement (PL11) en alleen-lezen links (E3). Valt het uit, dan werkt alles gewoon verder. Het is een versneller, geen voorwaarde: zonder werkt alles, alleen PL11 en E3 vallen terug op een export (N6).
- **K7** **Syncstatus:** elk apparaat toont wanneer het laatst met welk apparaat synchroniseerde ("gsm keuken, 5 minuten geleden") en of er wijzigingen nog niet gedeeld zijn.
- **K8** **Ontkoppelen:** een beheerder kan een apparaat ontkoppelen, bv. bij verlies. De andere apparaten wisselen dan van sleutel, zodat het nieuwe gegevens niet meer krijgt; wat er al op stond, blijft er wel op. Daarom kan de app op elk apparaat vergrendeld worden met een pincode of vingerafdruk, en zijn de gegevens op het apparaat versleuteld.
- **K9** **Verschillende versies samen:** een apparaat met een oudere versie van de app blijft synchroniseren met een nieuwere. Gegevens die de oude versie niet kent, laat ze ongemoeid, en ze vraagt om bij te werken.
- **K10** **Webweergave via het thuisnetwerk:** op een pc waar je de app niet mag installeren (bv. een werklaptop), werk je in de browser met de gegevens van een gekoppelde gsm. Je zet de webweergave aan op de gsm; die toont een adres en een eenmalige sessiecode, die je in de browser intikt. Dit werkt enkel als gsm en pc op hetzelfde lokale netwerk zitten. De pc bewaart niets; de sessie stopt bij "stop", na een tijd zonder gebruik of als de app op de gsm afsluit. Omdat de verbinding op het lokale netwerk niet via HTTPS kan, staat de webweergave standaard uit, toont de gsm een melding zolang ze aanstaat, en waarschuwt de app op een onbekend netwerk.
- **K11** **Zuinig op de achtergrond:** een gsm houdt op de achtergrond geen verbinding open. Hij synchroniseert bij het openen van de app, bij het verlaten ervan en wanneer Android de app kort laat draaien. Hangt de gsm aan de lader op wifi, dan staat de laadmodus aan: de app blijft bereikbaar (met een melding) en wisselt wijzigingen en grote bijlagen uit met elk bereikbaar apparaat. Zo staan wijzigingen uiterlijk na een nacht aan de lader op elke gsm. Herinneringen berekent elk apparaat zelf, zonder netwerk. Altijd bereikbaar blijven, ook zonder lader, kan als keuze per apparaat; dat kost batterij.
- **K12** **Synchroniseren in elkaars buurt:** twee gekoppelde gsm's die dicht bij elkaar zijn, synchroniseren ook zonder gemeenschappelijk netwerk of internet, bv. samen onderweg in de auto. Een wijziging op de ene gsm staat binnen een minuut op de andere, zonder dat iemand iets moet aanzetten. Dat gebeurt via Bluetooth Low Energy, dat elke Android-gsm heeft; ondersteunen beide gsm's Wi-Fi Aware, dan gaat het sneller via die weg. Via Bluetooth gaan enkel wijzigingen, geen bijlagen; die volgen via Wi-Fi Aware of later thuis. De syncstatus (K7) toont dat het via Bluetooth gebeurde, zodat je ziet dat je alles mee hebt. Wat een gsm uitzendt, wisselt regelmatig, zodat niemand een huishouden kan herkennen of volgen. Past binnen K11: er blijft geen verbinding open, een gsm wordt enkel kort gewekt als een gekoppelde gsm met nieuwe wijzigingen in de buurt is. Eerst enkel tussen Android-gsm's.

### Gegevens

- **G1** Alle gegevens van het huishouden exporteren, inclusief de opgeladen bestanden, zodat we nooit vastzitten aan de app.
- **G2** Bijlagen (foto's, offertes, facturen) staan op elk apparaat, zodat je ze ook kunt openen als geen ander apparaat bereikbaar is. De app verkleint foto's bij het toevoegen (langste zijde 2048 px, ongeveer 400 KB) en maakt van een document dat je in de app scant een kleine pdf. Boven 10 MB waarschuwt de app, boven 25 MB kan een bijlage niet. Grote bijlagen (vanaf 1 MB) gaan standaard enkel via wifi. Per apparaat kun je kiezen om grote bijlagen pas op te halen als je ze opent; de app waarschuwt dan dat dat enkel lukt als een apparaat met het bestand bereikbaar is. De app toont hoeveel opslag bijlagen innemen. Bijlagen zitten niet in de wijzigingsgeschiedenis, zodat een verwijderde bijlage na een tijd ook echt ruimte vrijmaakt.
- **G3** Back-up: een volledige back-up naar één bestand, op elk apparaat te maken en terug te zetten. Elk apparaat kan automatisch een back-up maken naar een gekozen map, bv. een netwerkmap op de NAS, in de laadmodus (K11). Het altijd-aan-apparaat maakt er dagelijks automatisch een.

## Niet-functionele eisen

Hoe de app moet zijn, los van wat hij doet.

| Onderwerp | Eis |
| --- | --- |
| Taal | Nederlands; teksten van bij het begin vertaalbaar opgezet, met het oog op open source |
| Schermen | Apps voor Android (gsm en tablet), Windows en Linux; later eventueel iOS en macOS. Alles werkt offline (H9) |
| Toegankelijkheid | WCAG 2.2 niveau AA als doel |
| Beveiliging | Enkel gekoppelde apparaten krijgen gegevens (K2); sync end-to-end versleuteld (K4); gegevens op het apparaat versleuteld en app-vergrendeling met pincode of vingerafdruk (K8); alleen-lezen links (E3) zijn de enige toegang zonder gekoppeld apparaat |
| Meerdere huishoudens | Eerst één huishouden; elk huishouden is een apart versleuteld geheel, zodat een apparaat later bij meerdere huishoudens kan horen (A4) |
| Privacy | Geen tracking, geen externe scripts of lettertypes, geen gegevens naar derden (ook niet voor de snelle invoer, H8; een eventueel AI-model draait lokaal) |
| Hosting | Geen hosting nodig: elk apparaat heeft alle gegevens. Optioneel een altijd-aan-apparaat thuis (K6) en een eigen relay (K3) |
| Installeren en bijwerken | Releases op GitHub. Android: een APK, updates via Obtainium; later een eigen F-Droid-repository. Windows en Linux: een installatiebestand en een AppImage, updates via de updater van Tauri na bevestiging. Alles ondertekend met een sleutel die op twee plaatsen bewaard wordt (N8) |
| Licentie | AGPL-3.0: wie de app aanpast en online aanbiedt, moet de code ook delen |
| Betrouwbaarheid | Elk apparaat heeft een volledige kopie; back-up naar een bestand op elk apparaat, automatisch naar een gekozen map of dagelijks op het altijd-aan-apparaat (G3) |
| Snelheid | Een huishouden heeft honderden tot enkele duizenden taken; elk scherm laadt vlot met die hoeveelheid |
| Synchroniseren | Wijzigingen staan binnen enkele seconden op andere apparaten die bereikbaar zijn; zonder relay of altijd-aan-apparaat staan ze uiterlijk na een nacht aan de lader op elke gsm (K11). Synchroniseren trekt de batterij van een gsm niet merkbaar leeg |
| Dataverkeer en opslag | Enkel wijzigingen gaan over het netwerk (ongeveer 1 KB per wijziging, enkele MB per maand); grote bijlagen standaard enkel via wifi. Bijlagen worden bij het toevoegen verkleind en staan buiten de wijzigingsgeschiedenis (G2) |

## Oplevering in stappen

Acht stappen, elk op zich al bruikbaar. De volgorde is goedgekeurd (V8); de nieuwe eisen uit de voorstellen zijn erin verdeeld. Door de keuze voor local-first (N4) zitten koppelen en synchroniseren al in stap 1, want achteraf toevoegen is veel moeilijker.

| Stap | Inhoud | Eisen |
| --- | --- | --- |
| 1. Fundament | Apps voor Android, Windows en Linux, lokale opslag, huishouden aanmaken, koppelen met een QR-code, synchroniseren, leden, ruimtes, leeg startscherm | A1–A4, K1–K5, K7–K9, K11, H9, R1 |
| 2. Huistaken | Eenmalige en terugkerende taken, vandaag en deze week, inschatting van werk en tijd, snelle invoer, altijd-aan-apparaat | H1–H8, K6, D1 (deel) |
| 3. Projecten | Projecten, taken, fasen, voortgang, archief, beslissingen, materiaal | P1–P9, PL1, PL2, PL6 |
| 4. Budget en offertes | Budgetten, reserve, uitgaven met bewijs, prognose, offertes, externen, premies | B1–B10, O1–O6, E1, E2 |
| 5. Planning | Tijdlijn, agenda, afhankelijkheden, oorspronkelijk plan, tijd, weer, agenda-abonnement | PL3–PL5, PL7–PL11, D1 |
| 6. Ideeënbord | Foto's, links, kleuren, notities | I1–I5 |
| 7. Huis en sjablonen | Toestellen, onderhoud, sjablonen | R2–R4, S1–S3 |
| 8. Delen en gegevens | Alleen-lezen links, export, back-up, grote bijlagen, webweergave via het thuisnetwerk | E3, G1–G3, K10 |

### Bewust buiten scope (voorlopig)

- Herinneringen per mail of pushmelding: eventueel later, niet in de eerste versie (V7). Tot dan tonen het startscherm en het agenda-abonnement (PL11) wat er moet gebeuren.
- AI-analyse met een lokaal model: eventueel in een volgende fase (N1).
- Functies voor bedrijven of teams buiten het huishouden (facturatie, uren aanrekenen, klantenbeheer).
- Externen als gebruiker van de app (inloggen als vakman); een alleen-lezen link (E3) is het enige wat zij te zien krijgen.
- Boekhouding: de app volgt kosten op, maar is geen boekhoudpakket.
- Live samenwerken (twee mensen die tegelijk hetzelfde scherm bewerken en elkaars wijzigingen meteen zien).
- Publicatie in de Play Store, de Microsoft Store of de officiële F-Droid-catalogus: eerst via GitHub Releases (N8); een eigen F-Droid-repository en stores eventueel later.
- Webweergave buiten het thuisnetwerk (bv. op het werk): eventueel later via WebRTC. De browser laadt de app dan van een vaste HTTPS-pagina en maakt een end-to-end versleutelde, rechtstreekse verbinding met de gsm; daarvoor is een kleine server nodig om de verbinding op te zetten, en soms een relay (N5).
- iOS en macOS: eerst niet. Dezelfde code kan later ook daar draaien, maar vraagt een Apple-ontwikkelaarsaccount.
- Synchroniseren buitenshuis: eventueel later rechtstreeks via internet over IPv6, of via een zelf gedraaide relay; nooit een vereiste (N7). Gsm's die samen onderweg zijn, synchroniseren wel met elkaar (K12).
- Een centrale server als verplicht onderdeel; het altijd-aan-apparaat blijft optioneel (K6).

## Beslissingen en open taken

Alle vragen zijn beantwoord en verwerkt in de eisen.

| # | Vraag | Beslissing | Verwerkt in |
| --- | --- | --- | --- |
| V1 | Gebruiken anderen in het huishouden de app ook? | Ja: de twee volwassenen van het huishouden | A1 |
| V2 | Volstaan de rollen beheerder en lid? | Ja, die twee volstaan | A2 |
| V3 | Eén of meerdere huishoudens per installatie? | Eerst enkel ons huishouden, maar opgezet zodat hosten voor anderen later kan | A4 |
| V4 | Welke techniek? | Eerst: webapp met Node.js en TypeScript, PostgreSQL en Docker. Herzien op 11 november 2026, zie N4 | Technisch document |
| V5 | Bedragen inclusief of exclusief btw? | Vergelijkingen altijd inclusief btw | B7 |
| V6 | Welke licentie bij open source? | AGPL-3.0 | Niet-functionele eisen |
| V7 | Herinneringen per mail of pushmelding? | Eventueel in een latere fase, niet in de eerste versie | Buiten scope |
| V8 | Is de volgorde van de stappen goed? | Ja | Oplevering in stappen |
| N1 | Snelle invoer: vaste zinnen of een AI-assistent? | Gewone logica waar mogelijk; in een volgende fase eventueel een lokaal AI-model | H8, niet-functionele eisen |
| N2 | Wat toont een alleen-lezen link, en hoe lang is hij geldig? | Voorstel ok om te beginnen (planning, taakomschrijving, ideeën; geen bedragen; 30 dagen); verder uitwerken bij de bouw | E3 |
| N3 | Offline: enkel afvinken, of ook aanmaken en bewerken? | Enkel afvinken; lage prioriteit. Vervangen door N4: alles werkt offline | H9 |
| N4 | Een centrale server, of alles lokaal op elk apparaat? | Local-first (11 november 2026): apps voor Android, Windows en Linux, alle gegevens op elk apparaat, synchroniseren na koppelen met een QR-code, optioneel een altijd-aan-apparaat. Richting: Tauri 2 met TypeScript, SQLite en een CRDT-bibliotheek (Automerge of gelijkaardig); details in het technisch document | K1–K9, H9, A1–A4, niet-functionele eisen |
| N5 | Hoe gebruik je de app op een pc waar je geen software mag installeren? | Webweergave via het thuisnetwerk (11 november 2026): de gsm toont de app in de browser van de pc, na het intikken van een eenmalige sessiecode. Een variant via WebRTC die ook buitenshuis werkt (bv. op het werk), is een mogelijke uitbreiding voor later | K10, Bewust buiten scope |
| N6 | Hoe houden we dataverkeer, opslag en batterijverbruik laag, zonder dat een apparaat verplicht is? | Elke functie werkt in een huishouden met enkel gsm's (11 november 2026); pc, altijd-aan-apparaat en relay versnellen enkel. Bijlagen staan op elk apparaat, verkleind bij het toevoegen en buiten de wijzigingsgeschiedenis. Een gsm houdt op de achtergrond geen verbinding open, behalve aan de lader (laadmodus) of als je dat kiest. Basis: de Android-test (poc/android) toonde dat Android een app zonder voorgronddienst binnen 5 s bevriest, en dat met voorgronddienst berichten binnen ongeveer 1 s aankomen, ook in diepe slaap. De NAS dient als optionele bestemming voor back-ups; een rechtstreekse koppeling voor bijlagen is niet nodig | K1, K3, K6, K11, G2, G3, niet-functionele eisen |
| N7 | Synchroniseren we buitenshuis via een relay, of enkel thuis? | Standaard enkel op hetzelfde netwerk (11 november 2026); onderweg werk je offline en alles komt samen zodra apparaten elkaar weer bereiken. Synchroniseren buitenshuis vraagt altijd dat de andere kant wakker en bereikbaar is: een gsm buiten de laadmodus luistert niet (K11), en een brievenbus (gedeelde map, cloudopslag, e-mail) is een altijd-aan-apparaat in een andere vorm, dus geen vereiste (N6). Uitbreiding voor later: rechtstreeks via internet over IPv6 als beide kanten het hebben en wakker zijn (bv. een gsm thuis in laadmodus); de apparaten vinden elkaar via de publieke BitTorrent-DHT met ondertekende, versleutelde adresrecords (pkarr), zonder server van het project. Gemeten op 11 november 2026 (poc/android): tussen een gsm op mobiel internet en een laptop thuis kwam via IPv6 niets door, ook niet als beide kanten tegelijk stuurden; de modem van de provider heeft geen instellingen voor de IPv6-firewall. Op dit netwerk werkt het dus niet. Een zelf gedraaide relay blijft een optie, nergens voor nodig. Gsm's die samen onderweg zijn, synchroniseren wel rechtstreeks met elkaar (N9) | K3, Bewust buiten scope |
| N8 | Hoe installeren de apparaten de app, en hoe krijgen ze updates? | Via GitHub Releases (11 november 2026): bij elke versietag bouwt een GitHub Action alle pakketten, ondertekent ze en publiceert ze; de repository is publiek (AGPL-3.0). Android: updates via Obtainium; een eigen F-Droid-repository op GitHub Pages kan later. Daarom van bij het begin: een vaste app-id, een oplopend versienummer, beschrijving en schermafbeeldingen in de mappen die F-Droid leest (fastlane), en geen onvrije bibliotheken zoals Google Play-diensten. Windows en Linux: de updater van Tauri. De ondertekeningssleutel wordt op twee plaatsen bewaard: wie hem verliest, kan de app niet meer bijwerken of registreren. App-id: org.freehouseholdplanner.app. Registratie bij Google (developer verification) pas wanneer Google ze voor Europa verplicht maakt: eerst een gratis account voor beperkte verspreiding (tot 20 toestellen, geen identiteitsbewijs), een volledig account (25 dollar, identiteitsbewijs) pas als anderen de app gebruiken. Tot dan, of zonder registratie, kan een toestel apps toelaten via de advanced flow van Android (eenmalig, 24 uur wachten) | Niet-functionele eisen, Bewust buiten scope |
| N9 | Synchroniseren twee gsm's die samen onderweg zijn, zonder gemeenschappelijk netwerk? | Ja, via Bluetooth Low Energy en, waar beide gsm's het ondersteunen, Wi-Fi Aware (11 november 2026). Voorbeeld: de ene past tijdens een autorit iets aan in de app, de andere stapt uit met alle wijzigingen. Een hotspot opzetten is een te grote drempel en valt af. Google Nearby Connections valt af omdat het Google Play-diensten vereist (N8). Wi-Fi Direct valt af omdat Android bij het verbinden om bevestiging vraagt | K3, K12 |

### Open taken

- [x] Open vragen V1–V8 beantwoorden.
- [x] De voorstellen aanvaarden, uitstellen of weigeren.
- [x] Nieuwe open vragen N1–N3 beantwoorden.
- [x] Het technisch document (opbouw en techniek) opstellen: TECHNICAL.md, beslissingen T1–T6.
- [ ] Sync-techniek kiezen (Automerge, Yjs of een alternatief) met een proof of concept: twee gsm's en een laptop die offline wijzigen en daarna correct samenvoegen op het thuisnetwerk (N7).
- [x] README opstellen.
- [ ] Bijdragegids opstellen.
- [x] Diensttype voor de laadmodus kiezen: `connectedDevice`, zonder tijdslimiet; een dataSync-voorgronddienst mag op Android 15 en later maar 6 uur per 24 uur draaien (K11, zie poc/android).
- [x] Open vraag N7 beantwoorden (relay).
- [x] Rechtstreeks synchroniseren via IPv6 meten: lukt niet op ons netwerk (N7, poc/android).
- [ ] Proof of concept voor K12 op twee gsm's: Bluetooth (op de achtergrond ontdekken met een filter, wijzigingen uitwisselen) en Wi-Fi Aware; meten hoe snel wijzigingen overkomen en wat het aan batterij kost, en kiezen in welke opleverstap K12 komt (poc/nearby).
- [ ] Bij de eerste release: ondertekeningssleutel aanmaken en op twee plaatsen bewaren, release-Action opzetten (N8).
- [ ] De app registreren bij Google zodra de verificatieplicht voor ontwikkelaars in Europa geldt; een maandelijkse controle herinnert eraan (N8).

## Voorstellen

Van de 22 voorstellen zijn er 18 aanvaard en als eis opgenomen; 4 staan op later, geen enkel is geweigerd.

| # | Voorstel | Beslissing | Nu |
| --- | --- | --- | --- |
| X1 | Afhankelijkheden tussen taken | Aanvaard | PL7 |
| X2 | Wat houdt het project op? (kritiek pad) | Later | Later; bouwt verder op PL7 |
| X3 | Oorspronkelijk plan bewaren en vergelijken | Aanvaard | PL8 |
| X4 | Geschatte en werkelijke tijd voor eigen werk | Aanvaard | PL9 |
| X5 | Weergevoelige taken | Aanvaard | PL10 |
| X6 | Sjablonen en takenpakketten | Aanvaard | S1–S3 |
| X7 | Reserve voor onvoorziene kosten | Aanvaard | B8 |
| X8 | Uitgaven met bewijs | Aanvaard | B3, B9 |
| X9 | Betalingsschema en overzicht per maand | Later | Later |
| X10 | Premies en fiscale voordelen | Aanvaard | B10 |
| X11 | Offertes vergelijken op meer dan de prijs | Aanvaard | O6 |
| X12 | Beslissingen bijhouden | Aanvaard | P8 |
| X13 | Ruimtes | Aanvaard | R1 |
| X14 | Toestellen en documenten | Aanvaard | R2–R4 |
| X15 | Foto's van voor, tijdens en na | Later | Later |
| X16 | Materiaallijst en boodschappenlijst | Aanvaard | P9 |
| X17 | Beoordeling van externen | Later | Later |
| X18 | Inschatting van werk en tijd voor huistaken | Aanvaard | H7 |
| X19 | Agenda-abonnement | Aanvaard | PL11 |
| X20 | Alleen-lezen link voor externen | Aanvaard | E3 |
| X21 | Snelle invoer in gewone taal | Aanvaard | H8 |
| X22 | Offline afvinken | Aanvaard | H9 |
