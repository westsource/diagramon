using AvaloniaEdit.Highlighting;
using Diagramon.Services.Highlighting;

namespace Diagramon.Services;

public static class MermaidHighlightingProvider
{
    public const string MermaidXshd = """
<?xml version="1.0" encoding="utf-8"?>
<SyntaxDefinition name="Mermaid" extensions=".mmd;.mermaid" xmlns="http://icsharpcode.net/sharpdevelop/syntaxdefinition/2008">
  <Color name="Comment" foreground="#6A9955" />
  <Color name="Keyword" foreground="#0000CC" fontWeight="bold" />
  <Color name="Directive" foreground="#AF00DB" fontWeight="bold" />
  <Color name="Type" foreground="#267F99" />
  <Color name="String" foreground="#A31515" />
  <Color name="Number" foreground="#098658" />
  <Color name="Operator" foreground="#444444" />
  <Color name="BlockKeyword" foreground="#7A3E9D" fontWeight="bold" />
  <Color name="NodeId" foreground="#795E26" fontWeight="bold" />
  <Color name="EdgeLabel" foreground="#C41A16" />
  <Color name="ShapeText" foreground="#0451A5" />
  <Color name="ParticipantName" foreground="#0B6A9C" fontWeight="bold" />
  <Color name="ClassMember" foreground="#8B5A2B" />

  <RuleSet ignoreCase="false">
    <Span color="Comment" begin="%%" end="$" />

    <Rule color="Directive">\b(?:TB|TD|BT|LR|RL)\b</Rule>
    <Rule color="BlockKeyword">\b(?:subgraph|end)\b</Rule>
    <Rule color="Keyword">\b(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|title|section|participant|actor|loop|alt|else|opt|par|and|critical|break|rect|note|left of|right of|over|class|namespace|direction|click|style|linkStyle|dateFormat|axisFormat|todayMarker|excludes|includes|accDescr|accTitle)\b</Rule>
    <Rule color="Type">\b(?:true|false)\b</Rule>
    <Rule color="ParticipantName">(?&lt;=\b(?:participant|actor)\s)[A-Za-z_][A-Za-z0-9_]*\b</Rule>
    <Rule color="ClassMember">(?m)^[ \t]*[+#~-][^\r\n]*$</Rule>
    <Rule color="NodeId">\b[A-Za-z_][A-Za-z0-9_]*\b(?=\s*(?:\(|\{|\[))</Rule>
    <Rule color="EdgeLabel">\|[^|\r\n]+\|</Rule>
    <Rule color="ShapeText">(?&lt;=\[[^\]\r\n]{0,200})[^\]\r\n]+(?=\])</Rule>
    <Rule color="ShapeText">(?&lt;=\{[^\}\r\n]{0,200})[^\}\r\n]+(?=\})</Rule>
    <Rule color="ShapeText">(?&lt;=\([^\)\r\n]{0,200})[^\)\r\n]+(?=\))</Rule>
    <Rule color="Operator">(?:---|==&gt;|==|--&gt;|-\.?-&gt;|&lt;--&gt;|&lt;--|--|-\.-|-x|-o|\+\-)</Rule>
    <Rule color="String">"[^"]*"</Rule>
    <Rule color="String">'[^']*'</Rule>
    <Rule color="Number">\b\d+(\.\d+)?\b</Rule>
  </RuleSet>
</SyntaxDefinition>
""";

    public static IHighlightingDefinition Create()
    {
        return XshdLoader.Create(MermaidXshd);
    }
}
