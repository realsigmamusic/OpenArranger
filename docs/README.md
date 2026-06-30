# Estrutura e Criação de Estilos (.style) para OpenArranger

Um arquivo `.style` é essencialmente um pacote contendo os dados musicais (MIDI) e as diretrizes de mapeamento (JSON) que o OpenArranger precisa para reproduzir um ritmo corretamente.

---

## 1. Arquitetura do Arquivo `.style`

O formato `.style` é um arquivo compactado que deve conter exatamente a seguinte estrutura na sua raiz:

* **`NomeDoEstilo.zip`** ➔ Renomeado manualmente para **`NomeDoEstilo.style`**
* `style.mid` (Arquivo MIDI contendo o arranjo)
* `style.json` (Arquivo de configuração do mapa de seções)

> **Atenção:** Os arquivos `.mid` e `.json` devem estar diretamente na raiz do arquivo compactado, nunca dentro de subpastas.

---

## 2. Configuração do Arquivo `style.json`

O motor do OpenArranger ignora metadados nativos do MIDI (como BPM, fórmulas de compasso, marcadores ou mudanças de programa). Toda a inteligência e o mapeamento do ritmo **devem** ser declarados explicitamente no arquivo `.json`.

### Exemplo Base de Estrutura

```json
{
  "name": "16BeatBallad",
  "timeSignature": [4, 4],
  "bpm": 60,
  "Rhythm": 10,
  "subRhythm": 9,
  "sections": {
    "Main A": { "startBar": 2, "endBar": 6 },
    "Main B": { "startBar": 6, "endBar": 10 },
    "Main C": { "startBar": 10, "endBar": 14 },
    "Main D": { "startBar": 14, "endBar": 18 },
    "Fill In A": { "startBar": 18, "endBar": 19 },
    "Fill In B": { "startBar": 19, "endBar": 20 },
    "Fill In C": { "startBar": 20, "endBar": 21 },
    "Fill In D": { "startBar": 21, "endBar": 22 },
    "Intro A": { "startBar": 22, "endBar": 23 },
    "Intro B": { "startBar": 23, "endBar": 25 },
    "Intro C": { "startBar": 25, "endBar": 29 },
    "Ending A": { "startBar": 29, "endBar": 31 },
    "Ending B": { "startBar": 31, "endBar": 33 },
    "Ending C": { "startBar": 33, "endBar": 36 },
    "Break": { "startBar": 36, "endBar": 37 }
  }
}

```

### Ajuste de Unidade de Tempo (`beatUnit`)

Por padrão, o OpenArranger assume que a unidade de tempo é a semínima (`"4"`). Para trabalhar com **compassos compostos** (ex: $3/8$, $6/8$, $9/8$, $12/8$), você deve adicionar a propriedade `"beatUnit"` para definir a pulsação correta:

* `"4."` ➔ Semínima pontuada (Ideal para a maioria dos compassos compostos).
* `"8"` ➔ Colcheia.

**Dica de Automação:** Se você utiliza o **REAPER** como sua DAW principal, utilize o script customizado em Lua `exportStyleJSON.lua` (disponível [AQUI](../exportStyleJSON.lua)) para gerar este JSON de forma totalmente automática a partir da sua timeline. Essencial para fluxos de conversão de estilos Yamaha.

---

## 3. Especificações do Arquivo MIDI (`.mid`)

O arquivo de áudio deve ser exportado estritamente como **MIDI Tipo 0**. Ele pode conter um ou mais canais de instrumentação. O arranjo tradicional costuma seguir o padrão:

* **Canal 09:** Percussão
* **Canal 10:** Bateria

*Nota: Você pode endereçar qualquer canal que desejar, desde que o mapeamento correspondente seja devidamente indicado nas propriedades do seu JSON.*

---

## 4. Guia de Boas Práticas e Truques de Edição

Para garantir que a transição entre as seções ocorra de forma natural e sem atrasos ou engasgos no OpenArranger, siga estas diretrizes de estúdio:

### Organização de Linha de Tempo

* **Uso de Markers:** Embora o motor do arranjador ignore os marcadores internos do MIDI, manter a sua track de edição com marcadores claros facilita imensamente futuras revisões ou correções no projeto dentro da DAW.


### Dimensionamento das Seções

* **Fills & Breaks:** O tamanho ideal e recomendado para viradas (**Fills**) e quebras (**Breaks**) é de exatamente **1 compasso**.
* **Main (Loops Principais):** Variações simples funcionam com 1 compasso, mas para evitar repetições cansativas, o ideal é construir variações com **pelo menos 2 compassos** (sendo livre para estender para 4, 8 ou 16 compassos dependendo da complexidade do ritmo).
* **Intros & Endings:** Introduções e finalizações têm tamanho livre e variam de acordo com a proposta da música.

### O Truque do Prato de Ataque (Crash)

Para evitar que o prato de ataque corte o primeiro tempo do loop principal (`Main`) de forma abrupta, usamos uma técnica de compensação psicoacústica no final dos arquivos de transição (**Fills**, **Intros** e **Breaks**):

1. Vá até o **último tempo** do compasso da virada.
2. Desative o encaixe na grade da DAW (**Snap off**).
3. Posicione a nota do Prato de Ataque no **último instante possível** do compasso, garantindo que ela não invada o compasso seguinte.
4. Ajuste a duração da nota MIDI para o **menor tamanho possível**.

> **Resultado:** O OpenArranger lerá a nota milissegundos antes da virada de compasso. Ao ouvido humano, parecerá perfeitamente que o prato foi tocado no tempo um da próxima seção, criando uma transição fluida e natural.