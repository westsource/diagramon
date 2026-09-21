using System.IO;
using System.Xml;
using AvaloniaEdit.Highlighting;
using AvaloniaEdit.Highlighting.Xshd;

namespace Diagramon.Services;

/// <summary>
/// Graphviz DOT 语法高亮定义（XSHD），与 <see cref="MermaidHighlightingProvider"/> 同构。
/// </summary>
public static class DotHighlightingProvider
{
    public const string Xshd = """
<?xml version="1.0" encoding="utf-8"?>
<SyntaxDefinition name="DOT" extensions=".dot;.gv" xmlns="http://icsharpcode.net/sharpdevelop/syntaxdefinition/2008">
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

  <RuleSet ignoreCase="false">
    <Span color="Comment" begin="//" end="$" />
    <Span color="Comment" multiline="true" begin="/\*" end="\*/" />
    <Span color="Comment" begin="(?m)^[ \t]*#" end="$" />

    <Rule color="BlockKeyword">\b(?:strict|graph|digraph|subgraph|node|edge)\b</Rule>
    <Rule color="Keyword">\b(?:label|labelloc|labeljust|labelfontcolor|labelfontname|labelfontsize|labelangle|labeldistance|labelfloat|labelhref|labeltarget|labeltooltip|headlabel|taillabel|xlabel|headport|tailport|headclip|tailclip|headhref|tailhref|headURL|tailURL|headtarget|tailtarget|headtooltip|tailtooltip|head_lp|tail_lp|edgehref|edgeURL|edgetarget|edgetooltip|lhead|ltail|samehead|sametail|rank|rankdir|ranksep|nodesep|ratio|splines|layout|size|page|pagedir|center|rotate|orientation|margin|pad|ordering|overlap|overlap_scaling|overlap_shrink|pack|packmode|sep|esep|start|root|mindist|maxiter|mclimit|damping|defaultdist|dimen|dim|dim3|diredgeconstraints|distortion|dpi|epsilon|bgcolor|color|colorscheme|fillcolor|fontcolor|fontname|fontnames|fontsize|fontpath|forcelabels|gradientangle|height|width|fixedsize|image|imagescale|imagepath|inputscale|layer|layers|layerlistsep|layersep|levels|levelsgap|mode|model|neato_no_op|newrank|nojustify|nslimit|nslimit1|outputorder|pencolor|penwidth|peripheries|pin|pos|quadtree|quantum|remincross|resolution|samplepoints|scale|searchsize|shape|shapefile|showboxes|sides|skew|smoothing|sortv|stylesheet|style|target|tooltip|truecolor|URL|href|viewport|vertices|voro_margin|xdotversion|clusterrank|comment|compound|concentrate|constraint|decorate|dir|arrowhead|arrowtail|arrowsize|weight|minlen|class|id|z|group|K|dotversion)\b</Rule>
    <Rule color="Directive">\b(?:dot|neato|fdp|sfdp|twopi|circo)\b</Rule>
    <Rule color="Type">\b(?:true|false|none|solid|dashed|dotted|bold|filled|unfilled|rounded|diagonals|striped|wedged|invis|invisible|normal|inv|LR|RL|TB|BT|same|source|sink)\b</Rule>
    <Rule color="ShapeText">\b(?:box|box3d|polygon|triangle|invtriangle|pentagon|hexagon|septagon|octagon|doubleoctagon|tripleoctagon|trapezium|invtrapezium|parallelogram|house|invhouse|folder|note|tab|point|oval|ellipse|circle|doublecircle|diamond|Mdiamond|Msquare|Mcircle|square|rect|rectangle|star|record|Mrecord|component|promoter|cds|terminator|utr|underline|honeycomb|plaintext|plain|egg|cylinder|Image|vee|odot|invdot|invodot|tee|open|halfopen|crow|empty|odiamond|ediamond)\b</Rule>
    <Rule color="EdgeLabel">(?&lt;=\b(?:label|headlabel|taillabel|xlabel)\s*=\s*)"(?:[^"\\\r\n]|\\.)*"</Rule>
    <Rule color="String">(?&lt;!\b(?:label|headlabel|taillabel|xlabel)\s*=\s*)"(?:[^"\\\r\n]|\\.)*"</Rule>
    <Rule color="String">&lt;&lt;[^\r\n]*&gt;&gt;</Rule>
    <Rule color="String">&lt;[^&lt;&gt;\r\n]*&gt;</Rule>
    <Rule color="NodeId">\b[A-Za-z_][A-Za-z0-9_]*\b(?=\s*(?:-&gt;|--|\[|\{|\}|;|$))</Rule>
    <Rule color="Number">[+-]?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b</Rule>
    <Rule color="Operator">(?:-&gt;|--|==|!=|&lt;=|&gt;=)</Rule>
    <Rule color="Operator">[{}\[\];=]</Rule>
  </RuleSet>
</SyntaxDefinition>
""";

    public static IHighlightingDefinition Create()
    {
        using var stringReader = new StringReader(Xshd);
        using var xmlReader = XmlReader.Create(stringReader);
        return HighlightingLoader.Load(xmlReader, HighlightingManager.Instance);
    }
}