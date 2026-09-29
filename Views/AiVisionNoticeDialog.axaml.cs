using Avalonia.Controls;

using Diagramon.ViewModels;

namespace Diagramon.Views;

public partial class AiVisionNoticeDialog : Window
{
    public AiVisionNoticeDialog()
    {
        InitializeComponent();
    }

    public AiVisionNoticeDialog(AiVisionNoticeViewModel viewModel) : this()
    {
        DataContext = viewModel;
    }
}
